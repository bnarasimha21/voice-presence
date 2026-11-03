import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { clientIp, resolveSession, signSessionCookie } from "@/lib/request-context";

function requestWithHeaders(headers: Record<string, string>) {
  return new NextRequest("http://localhost:3000/api/chat", { headers });
}

describe("clientIp (finding 4)", () => {
  it("takes the right-most entry of X-Forwarded-For, trusting the one reverse-proxy hop", () => {
    // A client can prepend anything it likes to X-Forwarded-For; only the
    // platform's own reverse proxy appends the last entry, which is the
    // one actually reachable address.
    const req = requestWithHeaders({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("trims whitespace around entries", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "9.9.9.9 ,  203.0.113.5  " });
    expect(clientIp(req)).toBe("203.0.113.5");
  });

  it("falls back to 'unknown' when there is no X-Forwarded-For header at all", () => {
    const req = requestWithHeaders({});
    expect(clientIp(req)).toBe("unknown");
  });

  it("handles a single-entry header", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "203.0.113.5" });
    expect(clientIp(req)).toBe("203.0.113.5");
  });
});

describe("resolveSession (finding 4)", () => {
  it("returns a stable per-IP session id, not a fresh id every call, when there is no valid cookie", () => {
    const req1 = requestWithHeaders({ "x-forwarded-for": "9.9.9.9, 203.0.113.5" });
    const req2 = requestWithHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.5" });
    const session1 = resolveSession(req1);
    const session2 = resolveSession(req2);
    // Same real client IP (right-most entry) on both requests, even
    // though the client-controlled left-most entry differs, must resolve
    // to the same rate-limit/turn-cap id.
    expect(session1.sessionId).toBe(session2.sessionId);
    expect(session1.sessionId).toBe("ip:203.0.113.5");
  });

  it("gives different cookie-less clients different session ids", () => {
    const reqA = requestWithHeaders({ "x-forwarded-for": "203.0.113.5" });
    const reqB = requestWithHeaders({ "x-forwarded-for": "198.51.100.9" });
    expect(resolveSession(reqA).sessionId).not.toBe(resolveSession(reqB).sessionId);
  });

  it("still issues a cookie for the response even though the request-scoped id is IP-derived", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "203.0.113.5" });
    const session = resolveSession(req);
    expect(session.cookieToIssue).toBeTruthy();
  });

  // Adversarial-review follow-up: the first version of this fix minted a
  // fresh random UUID as the cookie to issue, even though the id used
  // for THIS request was IP-derived. A client that captured that fresh
  // UUID and sent it back got a brand-new, never-before-seen sessionId,
  // with its own fresh turn cap and rate-limit bucket, independent of
  // the IP bucket, undoing finding 4's whole point one request later.
  it("the cookie issued for a cookie-less request encodes the SAME ip-derived id, not a fresh random one", () => {
    const req = requestWithHeaders({ "x-forwarded-for": "203.0.113.5" });
    const session = resolveSession(req);
    expect(session.cookieToIssue).toBe(session.sessionId);
    expect(session.cookieToIssue).toBe("ip:203.0.113.5");
  });

  it("a harvested cookie-less response's cookie, sent back, resolves to the same ip-bound session, not a new one", () => {
    const req1 = requestWithHeaders({ "x-forwarded-for": "203.0.113.5" });
    const session1 = resolveSession(req1);
    const signedCookie = signSessionCookie(session1.cookieToIssue!);

    const req2 = requestWithHeaders({ cookie: `vp_session=${signedCookie}` });
    const session2 = resolveSession(req2);
    expect(session2.sessionId).toBe(session1.sessionId);
    // Already has a valid cookie now, so no new one needs issuing.
    expect(session2.cookieToIssue).toBeUndefined();
  });

  it("a valid signed cookie still wins over the IP fallback", () => {
    const signed = signSessionCookie("my-real-session");
    const req = requestWithHeaders({
      "x-forwarded-for": "203.0.113.5",
      cookie: `vp_session=${signed}`,
    });
    const session = resolveSession(req);
    expect(session.sessionId).toBe("my-real-session");
    expect(session.cookieToIssue).toBeUndefined();
  });
});
