import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse } from "@/lib/validate";
import { checkRateLimit, logRequest, recordSttUsage } from "@/lib/limits";
import { attachSessionCookie, resolveSession, sameOriginCheck } from "@/lib/request-context";

/**
 * Reads the request body up to `maxBytes`, aborting as soon as that many
 * bytes have arrived instead of buffering an unbounded upload and
 * checking its size only afterward. Returns null if the body exceeds the
 * limit.
 */
async function readBodyWithLimit(req: NextRequest, maxBytes: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    // reader.cancel() above already releases the lock via cancel(); a
    // plain break/return from the loop still needs the lock released.
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel()
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function handle(req: NextRequest, sessionId: string): Promise<Response> {
  const route = "/api/stt";

  // Issue 10: respect the same voice kill switch every other route
  // checks, before any upload is read or any provider call can be made.
  // Previously STT ignored VOICE_ENABLED, so Deepgram spend continued
  // even while voice was switched off everywhere else.
  if (!config.voiceEnabled) {
    logRequest({ route, status: 503, sessionId });
    return errorResponse(503, "voice_disabled", "Voice is currently disabled.");
  }

  if (isProduction() && !sameOriginCheck(req)) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(403, "cross_origin", "Cross-origin POSTs are not allowed.");
  }

  // Finding 4 follow-up: a higher, STT-specific ceiling (see
  // config.sttRateLimitMax), not the default rateLimitMax, so a shared
  // IP/NAT doing ordinary multi-person use does not exhaust the limit
  // and then 429 a genuine crisis message before it can be transcribed.
  const rate = checkRateLimit(`stt:${sessionId}`, config.sttRateLimitMax);
  if (!rate.allowed) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "rate_limited", "Too many requests.", { "Retry-After": String(rate.retryAfterSeconds) });
  }

  // Finding 2 (adversarial review): this route used to gate transcription
  // itself on the shared daily budget (isDailyBudgetExceeded, then a
  // reserveBudget("sttSeconds", ...) check before the provider call). The
  // UI is voice-only (VoiceChat.tsx calls /api/stt first, before there is
  // any text to run the crisis check on), so once the shared budget was
  // exhausted, a real crisis message could not even be transcribed: the
  // user got "Could not transcribe" and zero crisis resources, which is
  // the one failure mode this app cannot accept. The budget is a
  // cost/abuse control, not a safety control, and content cannot be
  // known before transcription happens, so it must never gate
  // transcription itself.
  //
  // Transcription is still bounded by the per-session rate limiter above
  // (a separate, cheap control that is never exhausted by this route
  // alone), and real STT usage is still recorded below for reporting and
  // for the daily budget's effect on what happens AFTER transcription
  // (the LLM/TTS calls in /api/chat, /api/turn, /api/tts), via
  // recordSttUsage. It is simply never used to deny the transcription
  // call itself.

  // Issue 10: reject an oversize body before reading it fully, checking
  // the declared Content-Length first (a cheap backstop for an honest
  // client) and then enforcing the real limit while streaming the body
  // in, instead of calling req.blob() (which buffers the entire upload
  // regardless of size) and checking afterward.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > config.maxSttBytes) {
    logRequest({ route, status: 413, sessionId });
    return errorResponse(413, "payload_too_large", "Audio exceeds the maximum upload size.");
  }

  const bytes = await readBodyWithLimit(req, config.maxSttBytes);
  if (bytes === null) {
    logRequest({ route, status: 413, sessionId });
    return errorResponse(413, "payload_too_large", "Audio exceeds the maximum upload size.");
  }
  if (!bytes.length) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "empty_audio", "Audio must not be empty.");
  }

  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  const audioBlob = new Blob([bytes.slice().buffer], { type: contentType });

  try {
    const result = await providers().stt.transcribe({
      audio: audioBlob,
      model: config.sttModel,
      signal: req.signal,
    });
    // Finding 2: usage is still recorded (for reporting, and so it counts
    // toward the daily sttSeconds budget that gates the LLM/TTS calls
    // that happen after transcription), but transcription itself was
    // never gated on it above.
    recordSttUsage(result.audioSeconds);
    logRequest({ route, status: 200, sessionId, audioSeconds: result.audioSeconds });
    return Response.json({ transcript: result.transcript });
  } catch (err) {
    if (err instanceof ProviderError) {
      logRequest({ route, status: 502, sessionId, provider: err.provider });
      return errorResponse(502, "provider_error", "Speech to text failed. Please try again.");
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
