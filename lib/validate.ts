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
