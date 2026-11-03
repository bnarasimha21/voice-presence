import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse, lookupPersona, parseJson, validateChatBody } from "@/lib/validate";
import { crisisSafetyReply, crisisTriggeredInMessages } from "@/lib/personas/prompt";
import {
  checkAndIncrementSessionTurns,
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  releaseBudget,
  reserveBudget,
  settleBudget,
} from "@/lib/limits";
import { attachSessionCookie, resolveSession, sameOriginCheck } from "@/lib/request-context";
import { SentenceChunker } from "@/lib/chunker";
import { TurnTiming } from "@/lib/timing";
import { id3CommentFrame } from "@/lib/id3";

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

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

async function handle(req: NextRequest, sessionId: string): Promise<Response> {
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

  // Issue 9: provider construction can throw (missing/invalid env config
  // for the selected provider set). Doing this before any stream exists
  // means a misconfiguration is a handled 500, not an uncaught exception
  // that only surfaces once the ReadableStream's start() callback runs.
  let llm: ReturnType<typeof providers>["llm"];
  let tts: ReturnType<typeof providers>["tts"];
  try {
    const p = providers();
    llm = p.llm;
    tts = p.tts;
  } catch {
    logRequest({ route, status: 500, sessionId });
    return errorResponse(500, "provider_config_error", "Voice is misconfigured. Please try again later.");
  }

  const timing = new TurnTiming();
  const disclosureTag = id3CommentFrame(
    "AI-generated voice. Not a recording of a real person speaking live."
  );

  // Issue 1 / 2 / 3: crisis detection runs on the user's messages before
  // the model is ever called, and deliberately before the daily budget
  // and per-session turn cap below: those are cost/abuse controls, not
  // safety controls, and must never be the reason a crisis safety reply
  // does not go out. When it trips, the fixed safety reply is the entire
  // turn: it is the only text streamed to the client and the only thing
  // synthesized to audio, so the spoken output always carries the safety
  // line and it is never at risk of truncation.
  if (crisisTriggeredInMessages(messages)) {
    const reply = crisisSafetyReply();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encodeEvent({ type: "text_delta", text: reply }));
        timing.mark("first_sentence");
        try {
          // Deliberately not gated on reserveBudget/isDailyBudgetExceeded:
          // the crisis safety line must always be attempted regardless of
          // the day's usage budget. A budget check could otherwise cause
          // the single most important audio output in this app to be
          // silently dropped.
          const result = await tts.synthesize({
            text: reply,
            voiceId: activePersona.voiceId,
            model: config.ttsModel,
            outputFormat: config.ttsOutputFormat,
          });
          timing.mark("tts_first_byte");
          const bytes = await streamToBytes(result.stream);
          const withTag = concatBytes(disclosureTag, bytes);
          timing.mark("first_audio_sent");
          controller.enqueue(
            encodeEvent({ type: "audio", data: Buffer.from(withTag).toString("base64") })
          );
        } catch {
          // Even if TTS fails, the client still gets the safety text; do
          // not let a synthesis failure hide the safety reply entirely.
        }
        timing.mark("turn_done");
        controller.enqueue(encodeEvent({ type: "done", reply, timing: timing.toObject() }));
        logRequest({ route, status: 200, sessionId, personaId: activePersona.id, crisis: 1 });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-AI-Generated-Voice": "true",
      },
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

  const abortedByClient = new AbortController();
  req.signal.addEventListener("abort", () => abortedByClient.abort());

  // Issue 6: reserve a worst-case token estimate before the provider call;
  // settled (or released) once the real usage is known, or on failure.
  // See lib/limits.ts for why this read-modify-write is atomic without a
  // lock under Node's single-threaded event loop.
  const estimatedTokens = estimateTokens(messages.map((m) => m.content).join(" ")) + config.maxReplyTokens;
  if (!reserveBudget("llmTokens", estimatedTokens)) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunker = new SentenceChunker();
      let fullText = "";
      let firstTokenSeen = false;
      let firstSentenceSeen = false;
      let disclosureSent = false;
      let spokenChars = 0;
      // Issue 7: usage must be recorded even if TTS fails after the LLM
      // succeeded, or if the client aborts mid-stream. This is set as
      // soon as it is known, and the outer finally below settles the
      // budget with whatever is here (falling back to a length estimate
      // if the generator never finished), so the reservation above is
      // never left dangling.
      let usage: { inputTokens: number; outputTokens: number } | null = null;

      // Issue 9: audio is capped at the same maxSpokenChars length used
      // for the text reply, so a long model output cannot produce
      // unbounded synthesized audio.
      function remainingAudioBudget(): number {
        return Math.max(0, config.maxSpokenChars - spokenChars);
      }

      async function speakSentence(sentence: string) {
        const budget = remainingAudioBudget();
        if (budget <= 0) return;
        const toSpeak = sentence.length > budget ? sentence.slice(0, budget) : sentence;
        if (!toSpeak) return;
        // Issue 6: reserve the ttsChars amount (known exactly up front)
        // before the provider call, same atomic pattern as /api/tts.
        if (!reserveBudget("ttsChars", toSpeak.length)) return;
        let result;
        try {
          result = await tts.synthesize({
            text: toSpeak,
            voiceId: activePersona.voiceId,
            model: config.ttsModel,
            outputFormat: config.ttsOutputFormat,
            signal: abortedByClient.signal,
          });
        } catch (err) {
          releaseBudget("ttsChars", toSpeak.length);
          throw err;
        }
        timing.mark("tts_first_byte");
        spokenChars += toSpeak.length;
        const rawBytes = await streamToBytes(result.stream);
        const bytes = disclosureSent ? rawBytes : concatBytes(disclosureTag, rawBytes);
        disclosureSent = true;
        timing.mark("first_audio_sent");
        if (abortedByClient.signal.aborted) return;
        controller.enqueue(
          encodeEvent({ type: "audio", data: Buffer.from(bytes).toString("base64") })
        );
      }

      try {
        const gen = llm.chatStream({
          model: config.llmModel,
          systemPrompt: activePersona.systemPrompt,
          messages,
          maxTokens: config.maxReplyTokens,
          signal: abortedByClient.signal,
        });

        // A plain `for await` discards an async generator's return value,
        // which is where chatStream puts the real input/output token
        // counts. Drive the iterator by hand so that value is not lost:
        // /api/chat bills on real usage from the provider, and this route
        // should too rather than falling back to a length estimate.
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
            if (abortedByClient.signal.aborted) break;
            if (!firstSentenceSeen) {
              firstSentenceSeen = true;
              timing.mark("first_sentence");
            }
            await speakSentence(sentence);
          }
          if (abortedByClient.signal.aborted) break;
          step = await gen.next();
        }
        if (step.done) {
          usage = { inputTokens: step.value.inputTokens, outputTokens: step.value.outputTokens };
        }

        // Issue 7: a client abort means no further audio should be
        // synthesized, including the sentence chunker's trailing
        // fragment. Flushing and speaking it after an abort was detected
        // defeated the point of aborting.
        if (!abortedByClient.signal.aborted) {
          const trailing = chunker.flush();
          if (trailing) {
            if (!firstSentenceSeen) timing.mark("first_sentence");
            await speakSentence(trailing);
          }
        }

        const reply = fullText.slice(0, config.maxSpokenChars);
        timing.mark("turn_done");

        if (!abortedByClient.signal.aborted) {
          controller.enqueue(
            encodeEvent({ type: "done", reply, timing: timing.toObject() })
          );
        }
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
      } finally {
        // Issue 7: settle (or release) the reservation no matter which
        // path got here: full success, a TTS failure after the LLM
        // succeeded, a client abort, or an LLM failure. Real usage is
        // used whenever the generator reported it; otherwise this falls
        // back to an estimate of what was actually produced so far,
        // which only ever overcounts slightly rather than leaking the
        // reservation forever.
        if (usage) {
          settleBudget("llmTokens", estimatedTokens, usage.inputTokens + usage.outputTokens);
        } else {
          releaseBudget("llmTokens", estimatedTokens);
          if (fullText) {
            settleBudget("llmTokens", 0, estimateTokens(fullText));
          }
        }
      }
    },
    cancel() {
      // Issue 7: no duck-typed `.cancel()` on the provider. Aborting this
      // controller is what actually stops the real Anthropic/ElevenLabs
      // calls in flight, via the AbortSignal threaded into every provider
      // call above.
      abortedByClient.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Server-Timing": timing.toServerTimingHeader(),
      "X-AI-Generated-Voice": "true",
    },
  });
}

export async function POST(req: NextRequest) {
  const session = resolveSession(req);
  const res = await handle(req, session.sessionId);
  return attachSessionCookie(res, session);
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
