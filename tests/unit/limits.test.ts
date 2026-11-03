import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimits,
  checkAndIncrementSessionTurns,
  resetSessionTurns,
  recordLlmUsage,
  isDailyBudgetExceeded,
  resetDailyUsage,
} from "@/lib/limits";

beforeEach(() => {
  resetRateLimits();
  resetSessionTurns();
  resetDailyUsage();
});

describe("checkRateLimit", () => {
  it("allows up to the configured max within a window, then 429s with retryAfter", () => {
    const key = "test-key";
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
    }
    const fourth = checkRateLimit(key, 3, 60_000);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", () => {
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("b", 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit("a", 1, 60_000).allowed).toBe(false);
  });
});

describe("checkAndIncrementSessionTurns", () => {
  it("allows up to the max turns then refuses", () => {
    const session = "s1";
    expect(checkAndIncrementSessionTurns(session, 2)).toBe(true);
    expect(checkAndIncrementSessionTurns(session, 2)).toBe(true);
    expect(checkAndIncrementSessionTurns(session, 2)).toBe(false);
  });
});

describe("daily budget", () => {
  it("is not exceeded at zero usage", () => {
    expect(isDailyBudgetExceeded()).toBe(false);
  });

  it("flags exceeded once llm token usage passes the configured budget", () => {
    recordLlmUsage(10_000_000); // far above any sane default
    expect(isDailyBudgetExceeded()).toBe(true);
  });
});
