import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse, lookupPersona, parseJson, validateTtsBody } from "@/lib/validate";
import { verifyReplyToken } from "@/lib/turn-token";
import {
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  recordTtsUsage,
} from "@/lib/limits";
import { sessionIdFromRequest, sameOriginCheck } from "@/lib/request-context";
import { id3CommentFrame } from "@/lib/id3";

export async function POST(req: NextRequest) {
  const sessionId = sessionIdFromRequest(req);
  const route = "/api/tts";

  // Issue 2: kill switch. Checked first and returns immediately, before
  // any provider call can be made.
  if (!config.voiceEnabled) {
    logRequest({ route, status: 503, sessionId });
    return errorResponse(503, "voice_disabled", "Voice is currently disabled.");
  }

  if (isProduction() && !sameOriginCheck(req)) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(403, "cross_origin", "Cross-origin POSTs are not allowed.");
  }

  const rate = checkRateLimit(`tts:${sessionId}`);
  if (!rate.allowed) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "rate_limited", "Too many requests.", { "Retry-After": String(rate.retryAfterSeconds) });
  }

  if (isDailyBudgetExceeded()) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }

  const parsed = await parseJson(req);
  if (!parsed.ok) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "bad_json", "Request body must be valid JSON.");
  }

  const validated = validateTtsBody(parsed.value);
  if (!validated.ok) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "invalid_body", validated.message);
  }

  // Issue 2: /api/tts never speaks free text. It only speaks the exact
  // text a reply token (minted by /api/chat) is bound to.
  const verified = verifyReplyToken(validated.value.replyToken);
  if (!verified.ok) {
    logRequest({ route, status: 400, sessionId, reason: verified.reason });
    return errorResponse(400, "invalid_token", "Reply token is invalid or expired.");
  }

  const persona = lookupPersona(verified.payload.personaId);
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

  const text = verified.payload.text;

  try {
    const result = await providers().tts.synthesize({
      text,
      voiceId: persona.voiceId,
      model: config.ttsModel,
      outputFormat: config.ttsOutputFormat,
    });

    recordTtsUsage(text.length);
    logRequest({ route, status: 200, sessionId, personaId: persona.id, chars: text.length });

    // Issue 3: layered, honest disclosure. A header and an ID3 comment
    // frame are strippable metadata, not a watermark; the README says so.
    const idTag = id3CommentFrame("AI-generated voice. Not a recording of a real person speaking live.");
    const stream = prependBytes(idTag, result.stream);

    return new Response(stream, {
      headers: {
        "Content-Type": result.contentType,
        "Transfer-Encoding": "chunked",
        "X-AI-Generated-Voice": "true",
      },
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      logRequest({ route, status: 502, sessionId, provider: err.provider });
      return errorResponse(502, "provider_error", "Text to speech failed. Please try again.");
    }
    logRequest({ route, status: 500, sessionId });
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}

function prependBytes(
  prefix: Uint8Array,
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let prefixSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        controller.enqueue(prefix);
        prefixSent = true;
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
