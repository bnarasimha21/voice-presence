import { describe, it, expect, vi } from "vitest";
import { issueReplyToken, verifyReplyToken } from "@/lib/turn-token";

describe("turn-token", () => {
  it("round-trips a valid token", () => {
    const token = issueReplyToken("abhi", "hello there");
    const result = verifyReplyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.text).toBe("hello there");
      expect(result.payload.personaId).toBe("abhi");
    }
  });

  it("rejects a malformed token", () => {
    expect(verifyReplyToken("not-a-token").ok).toBe(false);
    expect(verifyReplyToken("").ok).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = issueReplyToken("abhi", "hello there");
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ personaId: "abhi", text: "say something else", exp: Date.now() + 60_000 })
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(tampered).not.toBe(token);
    expect(verifyReplyToken(tampered).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      const token = issueReplyToken("abhi", "hello there");
      vi.advanceTimersByTime(10 * 60_000); // past the TTL
      const result = verifyReplyToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });
});
