import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimits,
  checkAndIncrementSessionTurns,
  resetSessionTurns,
  recordLlmUsage,
  isDailyBudgetExceeded,
  resetDailyUsage,
  bucketsSize,
} from "@/lib/limits";
import { config } from "@/lib/config";

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

  // Finding 4, part 2 (adversarial review, second pass): before
  // sweepBuckets existed, a key that resolveSession hands out for a
  // cookie-less request (a stable "ip:<address>" key, not a fresh UUID
  // per request) created an entry here that nothing ever removed. This
  // drives the real Date.now() clock forward past the configured TTL (no
  // fake timers wired into this suite) to prove old entries actually get
  // swept, same as sessionTurns already does.
  it("expires a rate-limit bucket once it is older than the configured TTL", () => {
    const originalTtl = config.rateLimitBucketTtlMs;
    config.rateLimitBucketTtlMs = 50;
    const realNow = Date.now;
    try {
      let fakeNow = realNow();
      Date.now = () => fakeNow;

      expect(checkRateLimit("ip:1.2.3.4", 20, 60_000).allowed).toBe(true);
      expect(bucketsSize()).toBeGreaterThanOrEqual(1);

      fakeNow += 1000; // well past the 50ms TTL
      // A call for an unrelated key triggers the sweep.
      checkRateLimit("ip:9.9.9.9", 20, 60_000);

      // The stale "ip:1.2.3.4" entry must be gone, not merely re-usable:
      // it should be bucketsSize() == 1 (only the fresh "ip:9.9.9.9" key).
      expect(bucketsSize()).toBe(1);
    } finally {
      Date.now = realNow;
      config.rateLimitBucketTtlMs = originalTtl;
    }
  });

  it("evicts the oldest entries once the bucket map exceeds maxSessionEntries", () => {
    // Adversarial-review follow-up: toBeLessThanOrEqual(2) on bucketsSize()
    // alone passes even if the wrong key gets evicted, or if every key
    // gets evicted. Use max=1 per key so a bucket at its cap denies the
    // next call, and a freshly re-created bucket (because it was evicted
    // and this call recreated it) allows it: that difference is how we
    // tell "k3 (newest) is still the original, full bucket" apart from
    // "k1 (oldest) was actually evicted, not just miscounted".
    const originalMax = config.maxSessionEntries;
    config.maxSessionEntries = 2;
    try {
      checkRateLimit("k1", 1, 60_000);
      checkRateLimit("k2", 1, 60_000);
      checkRateLimit("k3", 1, 60_000); // triggers eviction of the oldest (k1)

      // k3 is the newest and must survive: its bucket is still at its
      // cap (tokens=1, max=1), so a second call is denied.
      expect(checkRateLimit("k3", 1, 60_000).allowed).toBe(false);

      // k1 is the oldest and must have been evicted: a call for it gets
      // a brand-new bucket (tokens reset to 1), so it is allowed again.
      expect(checkRateLimit("k1", 1, 60_000).allowed).toBe(true);
    } finally {
      config.maxSessionEntries = originalMax;
    }
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
