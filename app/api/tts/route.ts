import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse, lookupPersona, parseJson, validateTtsBody } from "@/lib/validate";
import { markTokenRedeemed, verifyReplyToken } from "@/lib/turn-token";
import {
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  releaseBudget,
  reserveBudget,
} from "@/lib/limits";
import { attachSessionCookie, resolveSession, sameOriginCheck } from "@/lib/request-context";
import { id3CommentFrame } from "@/lib/id3";

async function handle(req: NextRequest, sessionId: string): Promise<Response> {
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

  // Issue 11: the token is bound to the session that minted it. A token
  // captured from, or shared by, a different session cannot be redeemed
  // here even while it is still within its TTL.
  if (verified.payload.sessionId !== sessionId) {
    logRequest({ route, status: 400, sessionId, reason: "session_mismatch" });
    return errorResponse(400, "invalid_token", "Reply token is invalid or expired.");
  }

  // Issue 11: single-use. Redeeming the same token twice (a replay of a
  // captured token within its TTL) is rejected outright, before any
  // provider call, rather than re-billing synthesis on every replay.
  if (!markTokenRedeemed(validated.value.replyToken, verified.payload.exp)) {
    logRequest({ route, status: 400, sessionId, reason: "token_replayed" });
    return errorResponse(400, "invalid_token", "Reply token has already been used.");
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

  // Issue 6: the ttsChars amount is known exactly up front (the text's
  // own length), so this reserves it atomically before the provider call
  // and releases it if the call fails, closing the same check-then-record
  // race the LLM token budget had.
  if (!reserveBudget("ttsChars", text.length)) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }

  try {
    let result;
    try {
      result = await providers().tts.synthesize({
        text,
        voiceId: persona.voiceId,
        model: config.ttsModel,
        outputFormat: config.ttsOutputFormat,
        signal: req.signal,
      });
    } catch (err) {
      releaseBudget("ttsChars", text.length);
      throw err;
    }

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

export async function POST(req: NextRequest) {
  const session = resolveSession(req);
  const res = await handle(req, session.sessionId);
  return attachSessionCookie(res, session);
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
