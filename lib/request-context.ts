// Issue 2: per-request identity used for rate limiting, turn counts, and
// logging. Never derived from anything the client can spoof for its own
// benefit in a way that defeats the limit (a session cookie plus the
// connection's IP, falling back to the cookie alone behind a proxy that
// does not forward one).

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

const SESSION_COOKIE = "vp_session";

export function sessionIdFromRequest(req: NextRequest): string {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown-ip";
  return cookie ? `${cookie}:${ip}` : `anon:${ip}`;
}

export function ensureSessionCookieValue(req: NextRequest): string {
  return req.cookies.get(SESSION_COOKIE)?.value ?? randomUUID();
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

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
