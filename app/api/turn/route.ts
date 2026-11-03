import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse, lookupPersona, parseJson, validateChatBody } from "@/lib/validate";
import { applyCrisisBackstop } from "@/lib/personas/prompt";
import {
  checkAndIncrementSessionTurns,
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  recordLlmUsage,
  recordTtsUsage,
} from "@/lib/limits";
import { sessionIdFromRequest, sameOriginCheck } from "@/lib/request-context";
import { SentenceChunker } from "@/lib/chunker";
import { TurnTiming } from "@/lib/timing";

// Issue 4: one streaming turn. Replaces the three client round trips
// (/api/stt -> /api/chat -> /api/tts) with a single NDJSON stream of
// events so the browser can start playing audio on the first sentence
// instead of waiting for the whole reply and the whole MP3.
//
// Event shapes (one JSON object per line):
//   {"type":"text_delta","text":"..."}
//   {"type":"audio","data":"<base64 mpeg bytes>"}
//   {"type":"done","reply":"...","timing":{...}}
//   {"type":"error","code":"...","message":"..."}
//
// This route expects an already-transcribed turn (personaId + messages),
// matching /api/chat's contract plus streaming output. STT stays a
// separate step (issue drafts explicitly keep streaming STT out of
// scope); a client that wants one request per turn can call /api/stt
// first and feed the transcript in here.

function encodeEvent(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(req: NextRequest) {
  const sessionId = sessionIdFromRequest(req);
  const route = "/api/turn";

  if (!config.voiceEnabled) {
    logRequest({ route, status: 503, sessionId });
    return errorResponse(503, "voice_disabled", "Voice is currently disabled.");
  }
  if (isProduction() && !sameOriginCheck(req)) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(403, "cross_origin", "Cross-origin POSTs are not allowed.");
  }
  const rate = checkRateLimit(`turn:${sessionId}`);
  if (!rate.allowed) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "rate_limited", "Too many requests.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });
  }
  if (isDailyBudgetExceeded()) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }
  if (!checkAndIncrementSessionTurns(sessionId)) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "session_turn_limit", "Turn limit reached for this session.");
  }

  const parsed = await parseJson(req);
  if (!parsed.ok) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "bad_json", "Request body must be valid JSON.");
  }
  const validated = validateChatBody(parsed.value);
  if (!validated.ok) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "invalid_body", validated.message);
  }
  const { personaId, messages } = validated.value;
  const persona = lookupPersona(personaId);
  if (!persona) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "unknown_persona", "Unknown persona.");
  }
  if (!persona.usable) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(
      403,
      "persona_unavailable",
      "This persona's voice consent is not valid; it cannot be used."
    );
  }

  // Narrow once, outside the stream closure: TS does not carry the
  // `!persona` early-return's narrowing into a callback defined later in
  // the same function.
  const activePersona = persona;

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const timing = new TurnTiming();
  const { llm, tts } = providers();

  const abortedByClient = new AbortController();
  req.signal.addEventListener("abort", () => abortedByClient.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunker = new SentenceChunker();
      let fullText = "";
      let firstTokenSeen = false;
      let firstSentenceSeen = false;

      try {
        const gen = llm.chatStream({
          model: config.llmModel,
          systemPrompt: activePersona.systemPrompt,
          messages,
          maxTokens: config.maxReplyTokens,
        });

        async function speakSentence(sentence: string) {
          const result = await tts.synthesize({
            text: sentence,
            voiceId: activePersona.voiceId,
            model: config.ttsModel,
            outputFormat: config.ttsOutputFormat,
          });
          timing.mark("tts_first_byte");
          recordTtsUsage(sentence.length);
          const bytes = await streamToBytes(result.stream);
          timing.mark("first_audio_sent");
          controller.enqueue(
            encodeEvent({ type: "audio", data: Buffer.from(bytes).toString("base64") })
          );
        }

        // A plain `for await` discards an async generator's return value,
        // which is where chatStream puts the real input/output token
        // counts. Drive the iterator by hand so that value is not lost:
        // /api/chat bills on real usage from the provider, and this route
        // should too rather than falling back to a length estimate.
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        let step = await gen.next();
        while (!step.done) {
          const delta = step.value;
          if (abortedByClient.signal.aborted) break;
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            timing.mark("llm_first_token");
          }
          fullText += delta.text;
          controller.enqueue(encodeEvent({ type: "text_delta", text: delta.text }));

          const sentences = chunker.push(delta.text);
          for (const sentence of sentences) {
            if (!firstSentenceSeen) {
              firstSentenceSeen = true;
              timing.mark("first_sentence");
            }
            await speakSentence(sentence);
          }
          step = await gen.next();
        }
        if (step.done) {
          usage = { inputTokens: step.value.inputTokens, outputTokens: step.value.outputTokens };
        }

        const trailing = chunker.flush();
        if (trailing) {
          if (!firstSentenceSeen) timing.mark("first_sentence");
          await speakSentence(trailing);
        }

        const reply = applyCrisisBackstop(lastUserMessage, fullText).slice(
          0,
          config.maxSpokenChars
        );
        recordLlmUsage(usage ? usage.inputTokens + usage.outputTokens : estimateTokens(fullText));
        timing.mark("turn_done");

        controller.enqueue(
          encodeEvent({ type: "done", reply, timing: timing.toObject() })
        );
        logRequest({ route, status: 200, sessionId, personaId: activePersona.id });
        controller.close();
      } catch (err) {
        if (err instanceof ProviderError) {
          controller.enqueue(
            encodeEvent({ type: "error", code: "provider_error", message: "Provider failed." })
          );
          logRequest({ route, status: 502, sessionId, provider: err.provider });
        } else {
          controller.enqueue(
            encodeEvent({ type: "error", code: "internal_error", message: "Something went wrong." })
          );
          logRequest({ route, status: 500, sessionId });
        }
        controller.close();
      }
    },
    cancel() {
      abortedByClient.abort();
      if ("cancel" in llm && typeof (llm as { cancel?: () => void }).cancel === "function") {
        (llm as { cancel: () => void }).cancel();
      }
      if ("cancel" in tts && typeof (tts as { cancel?: () => void }).cancel === "function") {
        (tts as { cancel: () => void }).cancel();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Server-Timing": timing.toServerTimingHeader(),
    },
  });
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
