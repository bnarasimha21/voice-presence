// Issue 5: per-request identity used for rate limiting, turn counts, and
// logging. Previously fell back to `anon:<X-Forwarded-For>`, which is
// client-controlled and spoofable: rotating the header bypassed the
// per-session turn cap, and requests with no header at all shared a
// single "anon:unknown-ip" key. Fixed by actually issuing and verifying a
// server-signed session cookie: the signature cannot be produced without
// this server's secret, so the session id a client presents is either the
// one the server gave it or not trusted at all (in which case a fresh one
// is issued).

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { config, isProduction } from "@/lib/config";

const SESSION_COOKIE = "vp_session";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sessionSecret(): string {
  return config.sessionCookieSecret;
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Signs a session id (plus an expiry) into the cookie value format `id.exp.sig`. */
export function signSessionCookie(
  sessionId: string,
  exp: number = Date.now() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000
): string {
  const payload = `${sessionId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Verifies a cookie value and returns the session id, or null if invalid/expired/unsigned. */
export function verifySessionCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  if (!sessionSecret()) return null; // no secret configured: never trust a client-presented id
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, expStr, sig] = parts;
  if (!sessionId || !expStr || !sig) return null;

  let expected: string;
  try {
    expected = sign(`${sessionId}.${expStr}`);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  return sessionId;
}

export type SessionContext = {
  /** The id to use for rate limits, turn counts, and logging. */
  sessionId: string;
  /** Set when the request had no valid signed cookie; attach it to the response with attachSessionCookie. */
  cookieToIssue?: string;
};

/**
 * Resolves the session for this request from its signed cookie, issuing a
 * fresh random id (to be set on the response) if there is none or it does
 * not verify. Never derived from a client-supplied header.
 */
export function resolveSession(req: NextRequest): SessionContext {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const verified = verifySessionCookie(raw);
  if (verified) return { sessionId: verified };
  const fresh = randomUUID();
  return { sessionId: fresh, cookieToIssue: fresh };
}

/**
 * Attaches the signed session cookie to a response when the request did
 * not already carry a valid one. Call this once, right before returning,
 * on every response path (success and error) so a client's very first
 * request already gets a stable id for its retries.
 */
export function attachSessionCookie<T extends Response>(res: T, session: SessionContext): T {
  if (!session.cookieToIssue) return res;
  const signed = signSessionCookie(session.cookieToIssue);
  const attrs = [
    `${SESSION_COOKIE}=${signed}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (isProduction()) attrs.push("Secure");
  res.headers.append("Set-Cookie", attrs.join("; "));
  return res;
}

/**
 * Minimal same-origin check for state-changing POSTs: the Origin header,
 * when present, must match the request's own host. Browsers always send
 * Origin on cross-origin fetches, so a missing header here means either a
 * same-origin request (browsers omit Origin for some same-origin cases)
 * or a non-browser client, which the rate limiter and budgets still
 * cover.
 */
export function sameOriginCheck(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    return originHost === req.headers.get("host");
  } catch {
    return false;
  }
}
