import { NextRequest } from "next/server";
import { providers } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import { config, isProduction } from "@/lib/config";
import {
  errorResponse,
  extractLooseChatFields,
  lookupPersona,
  parseJson,
  validateChatBody,
} from "@/lib/validate";
import { issueReplyToken } from "@/lib/turn-token";
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

async function handle(req: NextRequest, sessionId: string): Promise<Response> {
  const route = "/api/chat";

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

  // Finding 1 (third adversarial review): validateChatBody's message-count
  // (40) and total-character (8000) caps are a cost/abuse control, not a
  // safety control, but they used to run BEFORE this crisis check. The
  // client always sends the full, untrimmed conversation history (see
  // components/VoiceChat.tsx), so a real conversation past ~20 turns (or
  // ~8000 total characters) was rejected outright with a flat 400 before
  // the crisis check ever ran, silencing the safety reply entirely for
  // exactly the users who have been talking long enough to need it most.
  //
  // This loose extraction deliberately does not enforce those caps, so
  // the crisis check below always gets a chance to run against an
  // otherwise well-formed body, oversized or not. The normal validation
  // path (validateChatBody) still runs further down for every non-crisis
  // request, so the caps are still enforced there; they are just never
  // allowed to be the reason a crisis message goes unanswered.
  const loose = extractLooseChatFields(parsed.value);
  const loosePersona = loose.personaId ? lookupPersona(loose.personaId) : null;
  if (loosePersona && loosePersona.usable && crisisTriggeredInMessages(loose.messages)) {
    const reply = crisisSafetyReply();
    const replyToken = issueReplyToken(loosePersona.id, reply, sessionId, true);
    logRequest({ route, status: 200, sessionId, personaId: loosePersona.id, crisis: 1 });
    return Response.json({ reply, replyToken });
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

  // Issue 6: reserve a worst-case token estimate before the provider call
  // and settle it to the real count afterward, so two concurrent requests
  // cannot both pass a "check then record" gap and overshoot the daily
  // budget. See lib/limits.ts for why this is safe without a lock.
  const estimatedTokens = estimateTokens(messages.map((m) => m.content).join(" ")) + config.maxReplyTokens;
  if (!reserveBudget("llmTokens", estimatedTokens)) {
    logRequest({ route, status: 429, sessionId });
    return errorResponse(429, "budget_exceeded", "Daily usage budget reached. Please try again tomorrow.");
  }

  try {
    let result;
    try {
      result = await providers().llm.chat({
        model: config.llmModel,
        systemPrompt: persona.systemPrompt,
        messages,
        maxTokens: config.maxReplyTokens,
      });
    } catch (err) {
      releaseBudget("llmTokens", estimatedTokens);
      throw err;
    }

    settleBudget("llmTokens", estimatedTokens, result.inputTokens + result.outputTokens);

    const reply = result.text.slice(0, config.maxSpokenChars);
    const replyToken = issueReplyToken(persona.id, reply, sessionId);

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

export async function POST(req: NextRequest) {
  const session = resolveSession(req);
  const res = await handle(req, session.sessionId);
  return attachSessionCookie(res, session);
}
