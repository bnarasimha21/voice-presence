import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { config } from "@/lib/config";

// Issue 8: the access-code gate, run through the real exported proxy
// function (renamed from `middleware` to `proxy` for Next.js 16's file
// convention rename). Verifies the Node `crypto` HMAC cookie signing
// round-trips, that the cookie never carries the plaintext code, that a
// missing ACCESS_CODE fails closed in production, and that the code
// comparison and signature checks reject tampering.

function requestTo(path: string, opts?: { cookie?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

describe("access-code proxy (issue 8)", () => {
  it("passes every request through when ACCESS_CODE is unset outside production", async () => {
    const originalCode = config.accessCode;
    config.accessCode = "";
    vi.stubEnv("NODE_ENV", "test");
    try {
      const res = await proxy(requestTo("/api/chat"));
      expect(res.status).toBe(200); // NextResponse.next() has no 401/redirect
    } finally {
      config.accessCode = originalCode;
      vi.unstubAllEnvs();
    }
  });

  it("fails closed with 401 when ACCESS_CODE is unset in production", async () => {
    // Issue 8: a missing env var in production must deny everyone, not
    // silently open the gate the way an unset code does in dev.
    const originalCode = config.accessCode;
    config.accessCode = "";
    vi.stubEnv("NODE_ENV", "production");
    try {
      const res = await proxy(requestTo("/api/chat"));
      expect(res.status).toBe(401);
    } finally {
      config.accessCode = originalCode;
      vi.unstubAllEnvs();
    }
  });

  it("rejects an API request with 401 when no cookie and no code are supplied", async () => {
    const original = config.accessCode;
    config.accessCode = "letmein";
    try {
      const res = await proxy(requestTo("/api/chat"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("access_denied");
    } finally {
      config.accessCode = original;
    }
  });

  it("sets a signed cookie, stripped of ?code=, when the correct code is supplied, and that cookie then passes", async () => {
    const original = config.accessCode;
    config.accessCode = "letmein";
    try {
      const withCode = await proxy(requestTo("/talk?code=letmein"));
      expect(withCode.status).toBe(307); // redirect, stripping ?code= from the URL
      const location = withCode.headers.get("location");
      expect(location).not.toContain("code=letmein");
      const setCookie = withCode.cookies.get("vp_access")?.value;
      expect(setCookie).toBeTruthy();
      // Issue 8: the cookie must never carry the plaintext access code.
      expect(setCookie).not.toContain("letmein");

      const withCookie = await proxy(requestTo("/talk", { cookie: `vp_access=${setCookie}` }));
      expect(withCookie.status).toBe(200);
    } finally {
      config.accessCode = original;
    }
  });

  it("rejects a tampered cookie signature", async () => {
    const original = config.accessCode;
    config.accessCode = "letmein";
    try {
      const withCode = await proxy(requestTo("/talk?code=letmein"));
      const goodCookie = withCode.cookies.get("vp_access")!.value;
      const [value] = goodCookie.split(".");
      const tampered = `${value}.not-the-real-signature`;

      const res = await proxy(requestTo("/talk", { cookie: `vp_access=${tampered}` }));
      expect(res.status).toBe(401);
    } finally {
      config.accessCode = original;
    }
  });

  it("the wrong ?code= is rejected with 401, not treated as a valid cookie value", async () => {
    const original = config.accessCode;
    config.accessCode = "letmein";
    try {
      const res = await proxy(requestTo("/talk?code=wrong-code"));
      expect(res.status).toBe(401);
    } finally {
      config.accessCode = original;
    }
  });

  it("a cookie signed under a different accessCookieSecret is rejected", async () => {
    // Issue 8: the cookie is signed with its own secret, not the access
    // code. Changing that secret must invalidate previously issued
    // cookies, same as rotating any other signing key.
    const originalCode = config.accessCode;
    const originalSecret = config.accessCookieSecret;
    config.accessCode = "letmein";
    try {
      const withCode = await proxy(requestTo("/talk?code=letmein"));
      const goodCookie = withCode.cookies.get("vp_access")!.value;

      config.accessCookieSecret = "a-completely-different-secret-value";
      const res = await proxy(requestTo("/talk", { cookie: `vp_access=${goodCookie}` }));
      expect(res.status).toBe(401);
    } finally {
      config.accessCode = originalCode;
      config.accessCookieSecret = originalSecret;
    }
  });

  it("a cookie issued under a different ACCESS_CODE is rejected (finding 5)", async () => {
    // Finding 5 (adversarial review, second pass): rotating ACCESS_CODE
    // is the actual response to a leaked code. A cookie issued under the
    // old code must stop working the moment the code changes, same as
    // rotating accessCookieSecret above; previously it stayed valid
    // forever because the signature was never bound to which code was
    // used to obtain it.
    const originalCode = config.accessCode;
    config.accessCode = "letmein";
    try {
      const withCode = await proxy(requestTo("/talk?code=letmein"));
      const goodCookie = withCode.cookies.get("vp_access")!.value;

      // Sanity: the cookie is valid under the code it was issued for.
      const stillGood = await proxy(requestTo("/talk", { cookie: `vp_access=${goodCookie}` }));
      expect(stillGood.status).toBe(200);

      config.accessCode = "a-new-rotated-code";
      const res = await proxy(requestTo("/talk", { cookie: `vp_access=${goodCookie}` }));
      expect(res.status).toBe(401);

      // The newly current code still works end to end, issuing a fresh
      // cookie that is itself valid.
      const withNewCode = await proxy(requestTo("/talk?code=a-new-rotated-code"));
      expect(withNewCode.status).toBe(307);
      const newCookie = withNewCode.cookies.get("vp_access")!.value;
      const withNewCookie = await proxy(requestTo("/talk", { cookie: `vp_access=${newCookie}` }));
      expect(withNewCookie.status).toBe(200);
    } finally {
      config.accessCode = originalCode;
    }
  });
});
