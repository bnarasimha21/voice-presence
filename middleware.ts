// Issue 2: access control. When ACCESS_CODE is set (the default
// expectation in production), every request must carry a signed cookie
// proving it was set by someone who knows the code. The code is checked
// via a `?code=` query param once (e.g. a link you share), which sets the
// cookie for subsequent requests; everything else needs the cookie.
//
// This is deliberately simple: it's a shared-secret gate for a demo app,
// not a user account system.
//
// Uses Web Crypto (globalThis.crypto.subtle) rather than Node's `crypto`
// module. Next.js middleware runs in the Edge Runtime by default, which
// does not support Node's `crypto`: an earlier version of this file
// imported `createHmac`/`timingSafeEqual` from it, which built but is not
// guaranteed to work at request time under Edge. crypto.subtle.verify is
// also the more directly correct tool here: it IS the MAC verification
// step, rather than reimplementing it by comparing two signatures.

import { NextRequest, NextResponse } from "next/server";

const ACCESS_COOKIE = "vp_access";
const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  // Buffer's backing store can type as ArrayBufferLike (incl.
  // SharedArrayBuffer), which Web Crypto's BufferSource rejects. Copy into
  // a plain ArrayBuffer-backed Uint8Array to satisfy that type exactly.
  return Uint8Array.from(buf);
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toBase64Url(sig);
}

async function validCookie(cookieValue: string | undefined, secret: string): Promise<boolean> {
  if (!cookieValue) return false;
  const [value, sig] = cookieValue.split(".");
  if (!value || !sig) return false;
  try {
    const key = await hmacKey(secret);
    return await crypto.subtle.verify("HMAC", key, fromBase64Url(sig), encoder.encode(value));
  } catch {
    // A malformed base64url signature throws rather than failing verify.
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;

  // No access code configured: gate is off (e.g. local dev).
  if (!accessCode) return NextResponse.next();

  const existing = req.cookies.get(ACCESS_COOKIE)?.value;
  if (await validCookie(existing, accessCode)) return NextResponse.next();

  const url = new URL(req.url);
  const suppliedCode = url.searchParams.get("code");
  if (suppliedCode === accessCode) {
    const res = NextResponse.next();
    res.cookies.set(ACCESS_COOKIE, `${accessCode}.${await sign(accessCode, accessCode)}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  }

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

export const config = {
  matcher: ["/api/:path*", "/talk"],
};
