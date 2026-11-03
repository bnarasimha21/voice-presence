// Issue 5: per-request identity used for rate limiting, turn counts, and
// logging. Previously fell back to `anon:<X-Forwarded-For>`, which is
// client-controlled and spoofable: rotating the header bypassed the
// per-session turn cap, and requests with no header at all shared a
// single "anon:unknown-ip" key. Fixed by actually issuing and verifying a
// server-signed session cookie: the signature cannot be produced without
// this server's secret, so the session id a client presents is either the
// one the server gave it or not trusted at all (in which case a fresh one
// is issued).
//
// Finding 4 (adversarial review, second pass): that fix left a different
// hole open. When no valid cookie is presented, resolveSession used to
// hand back a brand-new random UUID as the id used for THIS request's
// rate limit / turn cap checks. A client that simply never sends the
// cookie back (trivial: omit it, or use a fresh HTTP client per request)
// got a brand-new, never-before-seen id, and therefore a brand-new
// budget, on every single request: the turn cap and rate limiter never
// actually bound anything for a cookie-less caller.
//
// Fixed the same way lead-generator's app/request_guard.py binds
// anonymous callers to an IP instead of a client-rotatable value: when
// there is no valid session cookie, the id used for *this* request's
// limits is derived from the client's IP, read as the RIGHT-MOST entry of
// X-Forwarded-For. This app, like lead-generator, is only ever reachable
// through its platform's own reverse proxy (a single trusted hop), which
// appends its own observed peer address as the last entry of
// X-Forwarded-For; it does not strip whatever a client prepended. Taking
// the right-most entry trusts exactly that one hop and ignores every
// value the client itself could have put in the header, so a client can
// no longer get a fresh limits bucket by sending a fake X-Forwarded-For.
// A fresh signed cookie is still issued on the response so well-behaved
// clients converge onto a stable per-browser session on their very next
// request, same as before; only the cookie-less request itself now falls
// back to a shared-per-IP bucket instead of an unbounded fresh one.

import { createHmac, timingSafeEqual } from "crypto";
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

  // Finding 4 follow-up (adversarial review, second pass): a naive
  // `value.split(".")` expecting exactly 3 parts broke the moment
  // sessionId itself could contain a dot, which it now can: the
  // cookie-less fallback id is `ip:<dotted-decimal address>`
  // (lib/request-context.ts's resolveSession), and a dotted-decimal IPv4
  // address has three dots of its own. A cookie issued for that id used
  // to fail its own round-trip verification (parts.length was 6, not
  // 3), so every cookie-less client's "stable" cookie was silently
  // rejected on its very next request and treated as if it had never
  // presented one. The last two dot-separated segments are always
  // exp and sig (neither of which this module ever puts a literal "."
  // into: exp is a plain decimal number, sig is base64url, which does
  // not include "."); everything before that, rejoined on ".", is the
  // session id, however many dots it contains.
  const parts = value.split(".");
  if (parts.length < 3) return null;
  const sig = parts[parts.length - 1];
  const expStr = parts[parts.length - 2];
  const sessionId = parts.slice(0, parts.length - 2).join(".");
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
 * The client IP this request should be bounded under when it has no
 * valid session cookie: the RIGHT-MOST entry of X-Forwarded-For, which is
 * the one hop that can actually reach this process (see the finding-4
 * note above). Falls back to a fixed "unknown" bucket when no
 * X-Forwarded-For header is present at all (e.g. local dev with no proxy
 * in front), matching lead-generator's fallback to the raw ASGI peer
 * address for the same situation.
 */
// Adversarial-review follow-up: the right-most X-Forwarded-For entry used
// to be trusted verbatim as the literal text of the session id, which
// then gets written into a Set-Cookie header (attachSessionCookie) and
// into the HMAC payload. The one trusted hop (the platform's own reverse
// proxy) only ever appends a real IPv4/IPv6 address there, but nothing
// stops a misconfigured proxy, or this falling back to local dev with no
// proxy in front at all, from putting arbitrary attacker-controlled text
// in that position; a "," itself cannot smuggle a second cookie (the
// comma is the X-Forwarded-For delimiter, not a cookie-attribute
// delimiter), but there is no reason to trust arbitrary characters here
// when the only legitimate values are IP addresses. Only characters that
// can appear in an IPv4 or IPv6 address are accepted; anything else
// falls back to the fixed "unknown" bucket, same as a missing header.
const IP_SHAPE_RE = /^[0-9a-fA-F:.]+$/;

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && IP_SHAPE_RE.test(last)) return last;
  }
  return "unknown";
}

/**
 * Resolves the session for this request from its signed cookie. When
 * there is none, or it does not verify, THIS request's id for rate
 * limits/turn caps falls back to a per-IP key (clientIp above), never to
 * an unbounded fresh random id.
 *
 * Adversarial-review follow-up on finding 4: the first version of this
 * fix still issued a *fresh random UUID* as the cookie to set on the
 * response, even while using the IP-derived id for the current request.
 * That UUID is a validly signed cookie the moment it is issued, so a
 * client that captures it and sends it back on the next request gets an
 * entirely new, never-before-seen sessionId, with its own fresh turn cap
 * and fresh rate-limit bucket, independent of the IP bucket, for free.
 * Repeating "request cookie-less, harvest the new cookie, spend it once,
 * discard it, repeat" re-opens exactly the unbounded-identity-minting
 * hole finding 4 exists to close, just one request later.
 *
 * Fixed by never minting a fresh random id for a cookie-less request at
 * all: the cookie issued encodes the SAME ip-derived id already used for
 * this request. A client that later sends that cookie back converges
 * onto the identical "ip:<address>" session it would have resolved to
 * anyway, so there is no way to parlay a cookie-less request into a
 * brand-new identity.
 */
export function resolveSession(req: NextRequest): SessionContext {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const verified = verifySessionCookie(raw);
  if (verified) return { sessionId: verified };
  const fallback = `ip:${clientIp(req)}`;
  return { sessionId: fallback, cookieToIssue: fallback };
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
