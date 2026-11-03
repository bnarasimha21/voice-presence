// Issue 2: /api/chat returns a signed token bound to the exact reply text
// it generated; /api/tts will only speak a text it can verify came from
// that token. This stops the cloned voice from being an open
// text-to-speech endpoint for arbitrary text. It does not stop a user from
// trying to talk the model into saying a particular sentence: that is a
// prompt-injection problem the other controls (limits, persona prompt
// rules) address, and the README says so plainly.

import { createHmac, timingSafeEqual } from "crypto";
import { config } from "@/lib/config";

export type ReplyTokenPayload = {
  personaId: string;
  text: string;
  exp: number; // epoch ms
};

function secret(): string {
  if (!config.turnSecret) {
    throw new Error(
      "TURN_SECRET is not set. Set it in .env.local so /api/chat can sign reply tokens."
    );
  }
  return config.turnSecret;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

export function issueReplyToken(personaId: string, text: string): string {
  const payload: ReplyTokenPayload = {
    personaId,
    text,
    exp: Date.now() + config.replyTokenTtlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: ReplyTokenPayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyReplyToken(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, sig] = parts;

  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: ReplyTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.text !== "string" || typeof payload.personaId !== "string") {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, payload };
}
