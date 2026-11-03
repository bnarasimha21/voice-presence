import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import {
  errorResponse,
  lookupPersona,
  parseJson,
  validateChatBody,
} from "@/lib/validate";
import { issueReplyToken } from "@/lib/turn-token";
import { applyCrisisBackstop } from "@/lib/personas/prompt";
import {
  checkAndIncrementSessionTurns,
  checkRateLimit,
  isDailyBudgetExceeded,
  logRequest,
  recordLlmUsage,
} from "@/lib/limits";
import { sessionIdFromRequest, sameOriginCheck } from "@/lib/request-context";

export async function POST(req: NextRequest) {
  const sessionId = sessionIdFromRequest(req);
  const route = "/api/chat";

  if (!config.voiceEnabled) {
    logRequest({ route, status: 503, sessionId });
    return errorResponse(503, "voice_disabled", "Voice is currently disabled.");
  }

  if (isProduction() && !sameOriginCheck(req)) {
    logRequest({ route, status: 403, sessionId });
    return errorResponse(403, "cross_origin", "Cross-origin POSTs are not allowed.");
  }

  const rate = checkRateLimit(`chat:${sessionId}`);
  if (!rate.allowed) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "rate_limited", "Too many requests.", { "Retry-After": String(rate.retryAfterSeconds) });
  }

  if (isDailyBudgetExceeded()) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(
      429,
      "budget_exceeded",
      "Daily usage budget reached. Please try again tomorrow."
    );
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

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  try {
    const result = await providers().llm.chat({
      model: config.llmModel,
      systemPrompt: persona.systemPrompt,
      messages,
      maxTokens: config.maxReplyTokens,
    });

    recordLlmUsage(result.inputTokens + result.outputTokens);

    const reply = applyCrisisBackstop(lastUserMessage, result.text).slice(
      0,
      config.maxSpokenChars
    );
    const replyToken = issueReplyToken(persona.id, reply);

    logRequest({
      route,
      status: 200,
      sessionId,
      personaId: persona.id,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    return Response.json({ reply, replyToken });
  } catch (err) {
    if (err instanceof ProviderError) {
      logRequest({ route, status: 502, sessionId, provider: err.provider });
      return errorResponse(502, "provider_error", "The assistant failed to respond. Please try again.");
    }
    logRequest({ route, status: 500, sessionId });
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
