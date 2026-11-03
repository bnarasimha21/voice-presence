// Issue 8: access control. When ACCESS_CODE is set (the default
// expectation in production), every request must carry a signed cookie
// proving it was set by someone who knows the code. The code is checked
// via a `?code=` query param once (e.g. a link you share), which sets the
// cookie for subsequent requests; everything else needs the cookie.
//
// This is deliberately simple: it's a shared-secret gate for a demo app,
// not a user account system. It is NOT a secret boundary without HTTPS:
// without TLS, the `?code=` value and the resulting cookie both travel in
// the clear, so deploy this behind HTTPS only.
//
// Renamed from middleware.ts to proxy.ts: Next.js 16 deprecated the
// `middleware` file convention in favor of `proxy` (same file conventions,
// clearer name). Proxy also now defaults to the Node.js runtime rather
// than Edge, so this uses Node's `crypto` module directly instead of Web
// Crypto: `createHmac`/`timingSafeEqual` are the correct, simpler tool
// here, and the earlier Web-Crypto version existed only to work around
// the Edge Runtime restriction that no longer applies.
import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config as appConfig, isProduction } from "@/lib/config";

const ACCESS_COOKIE = "vp_access";

// The cookie never carries the access code itself, only proof that it was
// shown. Storing the plaintext code in a cookie value, even httpOnly,
// means it leaks into any server/proxy access log, and makes the cookie
// itself as sensitive as the code it is supposed to replace. "granted" is
// a fixed, non-secret marker; the HMAC over it is what's secret.
const GRANT_VALUE = "granted";

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

// A plain `===` on the supplied code leaks timing information proportional
// to how many leading bytes match the real code, letting an attacker
// recover it byte-by-byte. Hashing both sides to a fixed-length digest
// before comparing means `timingSafeEqual` is both safe to call
// (otherwise it throws on unequal-length inputs) and actually
// constant-time with respect to the real secret.
function constantTimeEqual(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest();
  const bHash = createHash("sha256").update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

function issueCookieValue(secret: string): string {
  return `${GRANT_VALUE}.${sign(GRANT_VALUE, secret)}`;
}

function validCookie(cookieValue: string | undefined, secret: string): boolean {
  if (!cookieValue) return false;
  const [value, sig] = cookieValue.split(".");
  if (value !== GRANT_VALUE || !sig) return false;
  const expected = sign(GRANT_VALUE, secret);
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

function denyResponse(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "access_denied", message: "An access code is required." } },
      { status: 401 }
    );
  }
  return new NextResponse("Access code required. Use the link you were given.", {
    status: 401,
  });
}

export async function proxy(req: NextRequest) {
  const accessCode = appConfig.accessCode;

  if (!accessCode) {
    // Issue 8: an unset ACCESS_CODE used to open the gate for everyone,
    // unconditionally, including in production. That is the exact
    // deployment where a missing env var (typo'd name, var not set in the
    // hosting dashboard, etc.) must not silently turn into "no access
    // control at all" for an app that can surface a deceased loved one's
    // cloned voice. Fail closed in production; stay open in local dev/CI
    // where there usually is no code configured at all.
    if (isProduction()) return denyResponse(req);
    return NextResponse.next();
  }

  const existing = req.cookies.get(ACCESS_COOKIE)?.value;
  if (validCookie(existing, appConfig.accessCookieSecret)) return NextResponse.next();

  const suppliedCode = req.nextUrl.searchParams.get("code");
  if (suppliedCode !== null && constantTimeEqual(suppliedCode, accessCode)) {
    // Issue 8: redirect to the same URL with `?code=` stripped, instead of
    // continuing to serve this response while the code still sits in the
    // URL. Left in place, it lingers in browser history, gets sent as the
    // Referer header to any third-party resource the page loads, and ends
    // up in server/proxy access logs on every subsequent request that
    // reuses the link.
    const cleanUrl = new URL(req.nextUrl);
    cleanUrl.searchParams.delete("code");
    const res = NextResponse.redirect(cleanUrl);
    res.cookies.set(ACCESS_COOKIE, issueCookieValue(appConfig.accessCookieSecret), {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

  return denyResponse(req);
}

export const config = {
  matcher: ["/api/:path*", "/talk"],
};
