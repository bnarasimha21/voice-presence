import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  issueReplyToken,
  markTokenRedeemed,
  resetRedeemedTokens,
  verifyReplyToken,
} from "@/lib/turn-token";

describe("turn-token", () => {
  beforeEach(() => {
    resetRedeemedTokens();
  });

  it("round-trips a valid token, bound to the issuing session", () => {
    const token = issueReplyToken("abhi", "hello there", "session-a");
    const result = verifyReplyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.text).toBe("hello there");
      expect(result.payload.personaId).toBe("abhi");
      expect(result.payload.sessionId).toBe("session-a");
    }
  });

  it("rejects a malformed token", () => {
    expect(verifyReplyToken("not-a-token").ok).toBe(false);
    expect(verifyReplyToken("").ok).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = issueReplyToken("abhi", "hello there", "session-a");
    const [, sig] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        personaId: "abhi",
        text: "say something else",
        sessionId: "session-a",
        exp: Date.now() + 60_000,
      })
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(tampered).not.toBe(token);
    expect(verifyReplyToken(tampered).ok).toBe(false);
  });

  it("rejects a token re-signed under a different session id", () => {
    // Simulates an attacker who captured a token and tries to claim it
    // under their own session by re-minting a payload with the same
    // text/persona but a different sessionId: this must fail signature
    // verification, since the signature covers the whole payload
    // including sessionId.
    const token = issueReplyToken("abhi", "hello there", "session-a");
    const [payloadB64] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...payload, sessionId: "session-b" })
    ).toString("base64url");
    const [, originalSig] = token.split(".");
    const forged = `${forgedPayload}.${originalSig}`;
    expect(verifyReplyToken(forged).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      const token = issueReplyToken("abhi", "hello there", "session-a");
      vi.advanceTimersByTime(10 * 60_000); // past the TTL
      const result = verifyReplyToken(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("single-use redemption", () => {
    it("allows the first redemption and rejects a replay of the same token", () => {
      const token = issueReplyToken("abhi", "hello there", "session-a");
      const verified = verifyReplyToken(token);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;

      expect(markTokenRedeemed(token, verified.payload.exp)).toBe(true);
      // A second redemption of the exact same token, still well within
      // its TTL, must be rejected: this is the replay a captured token
      // would attempt to re-bill TTS synthesis.
      expect(markTokenRedeemed(token, verified.payload.exp)).toBe(false);
    });

    it("lets two distinct tokens be redeemed independently", () => {
      const tokenA = issueReplyToken("abhi", "hello there", "session-a");
      const tokenB = issueReplyToken("abhi", "a different reply", "session-a");
      const verifiedA = verifyReplyToken(tokenA);
      const verifiedB = verifyReplyToken(tokenB);
      expect(verifiedA.ok && verifiedB.ok).toBe(true);
      if (!verifiedA.ok || !verifiedB.ok) return;
      expect(markTokenRedeemed(tokenA, verifiedA.payload.exp)).toBe(true);
      expect(markTokenRedeemed(tokenB, verifiedB.payload.exp)).toBe(true);
    });

    it("sweeps an expired redemption record so it does not grow forever", () => {
      const now = Date.now();
      const token = issueReplyToken("abhi", "hello there", "session-a");
      expect(markTokenRedeemed(token, now + 1000, now)).toBe(true);
      // Re-marking the same token after its own recorded expiry has
      // passed succeeds again, because the sweep drops it: a later,
      // distinct token happening to collide with an old swept-out entry
      // is not blocked forever.
      expect(markTokenRedeemed(token, now + 1000, now + 5000)).toBe(true);
    });
  });
});
