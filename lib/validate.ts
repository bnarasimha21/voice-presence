// Hand-written request validation and a uniform JSON error shape for every
// route. No external schema library: the three request bodies are small
// and fixed, and a few explicit checks are easier to audit than a new
// dependency for this size of app.

import { NextResponse } from "next/server";
import { personas, type PersonaId } from "@/lib/personas";
import type { ChatMessage } from "@/lib/providers/types";
import { config } from "@/lib/config";

export type ApiError = { error: { code: string; message: string } };

export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>
): NextResponse<ApiError> {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers }
  );
}

/**
 * Safe persona lookup. `personas` is a plain object, so a naive
 * `personas[id]` for id === "constructor" returns `Object` (truthy),
 * which let a bogus persona id slip past an "unknown persona" check
 * elsewhere in this app before this fix. `Object.hasOwn` rejects any key
 * that isn't a value actually assigned on the object, inherited or not.
 */
export function lookupPersona(id: unknown) {
  if (typeof id !== "string" || !Object.hasOwn(personas, id)) {
    return null;
  }
  return personas[id as PersonaId];
}

export async function parseJson(
  req: Request
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const value = await req.json();
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ChatBody = {
  personaId: string;
  messages: ChatMessage[];
};

export function validateChatBody(
  body: unknown
): { ok: true; value: ChatBody } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Body must be an object" };
  const { personaId, messages } = body;
  if (typeof personaId !== "string" || personaId.length === 0) {
    return { ok: false, message: "personaId must be a non-empty string" };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array" };
  }
  if (messages.length > config.maxChatMessages) {
    return {
      ok: false,
      message: `messages exceeds the maximum of ${config.maxChatMessages}`,
    };
  }
  let totalChars = 0;
  for (const m of messages) {
    if (
      !isRecord(m) ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return {
        ok: false,
        message: 'each message needs role "user" | "assistant" and string content',
      };
    }
    totalChars += m.content.length;
  }
  if (totalChars > config.maxChatChars) {
    return {
      ok: false,
      message: `messages exceed the maximum of ${config.maxChatChars} characters`,
    };
  }
  return {
    ok: true,
    value: { personaId, messages: messages as ChatMessage[] },
  };
}

// Finding 1 (third adversarial review): validateChatBody's message-count
// and total-character caps are a cost/abuse control, not a safety
// control, but they used to run BEFORE the crisis-phrase check in both
// /api/chat and /api/turn. The client always sends the full, untrimmed
// conversation history (see components/VoiceChat.tsx), so once a real
// conversation passed about 20 turns (or ~8000 total characters, easy to
// hit since replies can run up to maxSpokenChars), every later request
// was rejected outright with a flat 400 before the crisis check ever ran,
// silencing the one safety path this app cannot afford to lose.
//
// This extracts just enough shape (a persona id, and a loose list of
// well-formed messages) to run the crisis check against, deliberately
// without enforcing maxChatMessages/maxChatChars, so an oversized but
// otherwise well-formed body still gets a chance at the crisis
// short-circuit before validateChatBody's caps can reject it. A message
// that is not even shaped like `{role, content}` is simply dropped from
// this loose list rather than failing the whole extraction: the crisis
// check only needs to see the text that is actually there.
//
// Finding 1 follow-up (fourth adversarial review): removing the size
// caps here opened a new hole, since crisisTriggeredInMessages runs
// several passes of unicode-normalizing regex matching over whatever
// text it is given, and nothing bounded that text's size before this
// function ran. A handful of multi-megabyte message bodies (an attacker
// does not need a real conversation, just a well-formed POST) made that
// check itself the expensive operation, well before the rate limiter or
// budget checks in the route ever run. No real client needs this: a
// legitimate spoken turn is bounded by maxSpokenChars/maxChatChars (both
// far below the caps below), so these caps only ever bite an adversarial
// payload, never real usage. LOOSE_MAX_MESSAGES bounds how many raw
// entries get walked (the crisis check itself only ever looks at the
// last CRISIS_WINDOW_SIZE user messages, so anything earlier in a huge
// array is irrelevant to it); LOOSE_MAX_MESSAGE_CHARS bounds how much of
// any single message's content gets normalized and matched, keeping the
// last slice of it (a crisis statement in a rambling transcript is far
// more likely to land at the end than be buried under megabytes of
// padding before it).
export const LOOSE_MAX_MESSAGES = 200;
export const LOOSE_MAX_MESSAGE_CHARS = 20_000;

export function extractLooseChatFields(body: unknown): {
  personaId: string | null;
  messages: Pick<ChatMessage, "role" | "content">[];
} {
  if (!isRecord(body)) return { personaId: null, messages: [] };
  const personaId =
    typeof body.personaId === "string" && body.personaId.length > 0
      ? body.personaId
      : null;
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const tail =
    rawMessages.length > LOOSE_MAX_MESSAGES
      ? rawMessages.slice(-LOOSE_MAX_MESSAGES)
      : rawMessages;
  const messages = tail
    .filter(
      (m): m is Pick<ChatMessage, "role" | "content"> =>
        isRecord(m) &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content:
        m.content.length > LOOSE_MAX_MESSAGE_CHARS
          ? m.content.slice(-LOOSE_MAX_MESSAGE_CHARS)
          : m.content,
    }));
  return { personaId, messages };
}

export type TtsBody = {
  replyToken: string;
};

export function validateTtsBody(
  body: unknown
): { ok: true; value: TtsBody } | { ok: false; message: string } {
  if (!isRecord(body)) return { ok: false, message: "Body must be an object" };
  // Issue 2: /api/tts speaks only server-generated text bound to a token.
  // Free-form `text` is rejected outright, even if it also carries a token.
  if ("text" in body) {
    return {
      ok: false,
      message:
        "free-form text is not accepted; /api/tts only speaks a replyToken from /api/chat",
    };
  }
  if (typeof body.replyToken !== "string" || body.replyToken.length === 0) {
    return { ok: false, message: "replyToken must be a non-empty string" };
  }
  return { ok: true, value: { replyToken: body.replyToken } };
}
