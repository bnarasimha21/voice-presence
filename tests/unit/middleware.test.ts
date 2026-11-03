import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Issue 2: the access-code gate, run through the real exported middleware
// function. Verifies the Web Crypto HMAC cookie signing round-trips
// (the earlier version used Node's `crypto` module, which `next build`
// flagged as unsupported in the Edge Runtime middleware actually runs in)
// and that the gate behaves correctly open and closed.

function requestTo(path: string, opts?: { cookie?: string }) {
  const headers: Record<string, string> = {};
  if (opts?.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

describe("access-code middleware (issue 2)", () => {
  it("passes every request through when ACCESS_CODE is unset", async () => {
    const original = process.env.ACCESS_CODE;
    delete process.env.ACCESS_CODE;
    try {
      const res = await middleware(requestTo("/api/chat"));
      expect(res.status).toBe(200); // NextResponse.next() has no 401/redirect
    } finally {
      if (original !== undefined) process.env.ACCESS_CODE = original;
    }
  });

  it("rejects an API request with 401 when no cookie and no code are supplied", async () => {
    const original = process.env.ACCESS_CODE;
    process.env.ACCESS_CODE = "letmein";
    try {
      const res = await middleware(requestTo("/api/chat"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("access_denied");
    } finally {
      process.env.ACCESS_CODE = original;
    }
  });

  it("sets a signed cookie when the correct ?code= is supplied, and that cookie then passes", async () => {
    const original = process.env.ACCESS_CODE;
    process.env.ACCESS_CODE = "letmein";
    try {
      const withCode = await middleware(requestTo("/talk?code=letmein"));
      expect(withCode.status).toBe(200);
      const setCookie = withCode.cookies.get("vp_access")?.value;
      expect(setCookie).toBeTruthy();

      const withCookie = await middleware(
        requestTo("/talk", { cookie: `vp_access=${setCookie}` })
      );
      expect(withCookie.status).toBe(200);
    } finally {
      process.env.ACCESS_CODE = original;
    }
  });

  it("rejects a tampered cookie signature", async () => {
    const original = process.env.ACCESS_CODE;
    process.env.ACCESS_CODE = "letmein";
    try {
      const withCode = await middleware(requestTo("/talk?code=letmein"));
      const goodCookie = withCode.cookies.get("vp_access")!.value;
      const [value] = goodCookie.split(".");
      const tampered = `${value}.not-the-real-signature`;

      const res = await middleware(requestTo("/talk", { cookie: `vp_access=${tampered}` }));
      expect(res.status).toBe(401);
    } finally {
      process.env.ACCESS_CODE = original;
    }
  });

  it("the wrong ?code= is rejected with 401, not treated as a valid cookie value", async () => {
    const original = process.env.ACCESS_CODE;
    process.env.ACCESS_CODE = "letmein";
    try {
      const res = await middleware(requestTo("/talk?code=wrong-code"));
      expect(res.status).toBe(401);
    } finally {
      process.env.ACCESS_CODE = original;
    }
  });
});
