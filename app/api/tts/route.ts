import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse, lookupPersona, parseJson, validateTtsBody } from "@/lib/validate";
import { markTokenRedeemed, releaseRedeemedToken, verifyReplyToken } from "@/lib/turn-token";
import {
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  releaseBudget,
  reserveBudget,
} from "@/lib/limits";
import { attachSessionCookie, resolveSession, sameOriginCheck } from "@/lib/request-context";
import { id3CommentFrame } from "@/lib/id3";
import { getCachedCrisisAudio } from "@/lib/crisis-audio-cache";

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

  // Adversarial-review follow-up on finding 6: the rate limit used to run
  // before the token (and therefore isCrisis) was even known, so a
  // crisis reply's audio could 429 here from ordinary rate-limit
  // pressure, exactly the failure mode finding 6 exists to prevent on
  // /api/chat and /api/turn. The token is verified above first (cheap:
  // no provider call, just signature verification), so isCrisis is known
  // before any limit is applied; a crisis reply, like the budget check
  // below, bypasses this limiter entirely.
  if (!verified.payload.isCrisis) {
    const rate = checkRateLimit(`tts:${sessionId}`);
    if (!rate.allowed) {
      logRequest({ route, status: 429, sessionId });
      return errorResponse(429, "rate_limited", "Too many requests.", { "Retry-After": String(rate.retryAfterSeconds) });
    }
  }

  // Issue 11: single-use. Redeeming the same token twice (a replay of a
  // captured token within its TTL) is rejected outright, before any
  // provider call, rather than re-billing synthesis on every replay. This
  // reserves the token now (so a concurrent replay cannot sneak in while
  // synthesis is in flight); finding 7 below releases it again if
  // synthesis actually fails, so a transient provider failure does not
  // permanently burn a token that was never successfully redeemed.
  if (!markTokenRedeemed(validated.value.replyToken, verified.payload.exp)) {
    logRequest({ route, status: 400, sessionId, reason: "token_replayed" });
    return errorResponse(400, "invalid_token", "Reply token has already been used.");
  }

  // Adversarial-review finding: the daily budget is a cost control, not a
  // safety control. /api/chat already lets a crisis safety reply's TEXT
  // bypass the budget entirely; without this check, a crisis reply's
  // AUDIO could still be silently dropped here whenever the shared daily
  // budget happened to already be exhausted, which is normal operation,
  // not an attack. The isCrisis flag is set only by /api/chat, inside the
  // signed token, so a client cannot forge it to get free synthesis.
  if (!verified.payload.isCrisis && isDailyBudgetExceeded()) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
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
  // race the LLM token budget had. Skipped for a crisis reply, same as
  // the budget-exceeded check above: the safety reply's audio is never
  // gated on or counted against the shared daily budget.
  const isCrisis = verified.payload.isCrisis;
  if (!isCrisis && !reserveBudget("ttsChars", text.length)) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }

  try {
    // Cost/abuse finding: a crisis reply's text is a fixed constant per
    // persona, so its audio is synthesized once and served from cache on
    // every subsequent trigger, instead of re-paying the real TTS
    // provider for the same bytes every time. See
    // lib/crisis-audio-cache.ts. A cache/synthesis failure here still
    // falls through to the same error handling as an ordinary provider
    // failure below.
    if (isCrisis) {
      let cached;
      try {
        cached = await getCachedCrisisAudio(providers().tts, {
          text,
          voiceId: persona.voiceId,
          model: config.ttsModel,
          outputFormat: config.ttsOutputFormat,
        });
      } catch (err) {
        // Finding 7: synthesis failed, so this token was never actually
        // redeemed; release it so the same token can be retried instead
        // of forcing a whole new /api/chat round trip for a crisis reply.
        releaseRedeemedToken(validated.value.replyToken);
        throw err;
      }

      logRequest({ route, status: 200, sessionId, personaId: persona.id, chars: text.length });

      const idTag = id3CommentFrame("AI-generated voice. Not a recording of a real person speaking live.");
      const withTag = new Uint8Array(idTag.length + cached.bytes.length);
      withTag.set(idTag, 0);
      withTag.set(cached.bytes, idTag.length);

      return new Response(withTag, {
        headers: {
          "Content-Type": cached.contentType,
          "X-AI-Generated-Voice": "true",
        },
      });
    }

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
      // Adversarial-review follow-up on finding 7: releasing the token
      // unconditionally on any synthesis failure means the client itself
      // can manufacture the failure by aborting the request after it has
      // already reached the real provider (synthesize is given
      // req.signal above), then retry with the same token, over and
      // over, paying the provider nothing each time while still forcing
      // a real call every round. A client-initiated abort is not a
      // provider/infra failure, so it does not get the retry-friendly
      // treatment: the budget stays spent and the token stays redeemed,
      // same as a normal success, closing that loop. A genuine provider
      // failure (anything the client did not cause) still releases both,
      // same as before.
      if (!req.signal.aborted) {
        releaseBudget("ttsChars", text.length);
        releaseRedeemedToken(validated.value.replyToken);
      }
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
