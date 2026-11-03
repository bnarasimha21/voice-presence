import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import { errorResponse } from "@/lib/validate";
import { checkRateLimit, isDailyBudgetExceeded, logRequest, recordSttUsage } from "@/lib/limits";
import { sessionIdFromRequest, sameOriginCheck } from "@/lib/request-context";

export async function POST(req: NextRequest) {
  const sessionId = sessionIdFromRequest(req);
  const route = "/api/stt";

  if (isProduction() && !sameOriginCheck(req)) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(403, "cross_origin", "Cross-origin POSTs are not allowed.");
  }

  const rate = checkRateLimit(`stt:${sessionId}`);
  if (!rate.allowed) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "rate_limited", "Too many requests.", { "Retry-After": String(rate.retryAfterSeconds) });
  }

  if (isDailyBudgetExceeded()) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached.");
  }

  // Issue 2: reject an oversize body before reading it fully, checking the
  // declared Content-Length first and the actual bytes read as a backstop
  // for a missing or lying header.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > config.maxSttBytes) {
    logRequest({ route, status: 413, sessionId });
    return errorResponse(413, "payload_too_large", "Audio exceeds the maximum upload size.");
  }

  const audioBlob = await req.blob();
  if (audioBlob.size > config.maxSttBytes) {
    logRequest({ route, status: 413, sessionId });
    return errorResponse(413, "payload_too_large", "Audio exceeds the maximum upload size.");
  }
  if (!audioBlob.size) {
    logRequest({ route, status: 400, sessionId });
    return errorResponse(400, "empty_audio", "Audio must not be empty.");
  }

  try {
    const result = await providers().stt.transcribe({
      audio: audioBlob,
      model: config.sttModel,
    });
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
