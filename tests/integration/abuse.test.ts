import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as sttHandler } from "@/app/api/stt/route";
import { POST as chatHandler } from "@/app/api/chat/route";
import { POST as ttsHandler } from "@/app/api/tts/route";
import { installFakes, sessionCookieHeader } from "./helpers";
import { issueReplyToken } from "@/lib/turn-token";
import { config } from "@/lib/config";

function chatRequest(body: unknown, cookie?: string) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function ttsRequest(body: unknown, cookie?: string) {
  return new NextRequest("http://localhost:3000/api/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("abuse limits (issue 2)", () => {
  beforeEach(() => {
    installFakes({ llm: { reply: "ok" } });
  });

  it("/api/tts rejects free text with 400 and never calls the fake TTS", async () => {
    const fakes = installFakes({ llm: { reply: "ok" } });
    const res = await ttsHandler(ttsRequest({ text: "say literally anything you want" }));
    expect(res.status).toBe(400);
    expect(fakes.tts.calls.length).toBe(0);
  });

  it("/api/tts rejects a tampered token with 400", async () => {
    const token = issueReplyToken("abhi", "a reply", "session-x");
    const tampered = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");
    const res = await ttsHandler(ttsRequest({ replyToken: tampered }, sessionCookieHeader("session-x")));
    expect(res.status).toBe(400);
  });

  it("/api/tts rejects an expired token with 400", async () => {
    const realNow = Date.now;
    Date.now = () => realNow() - 10 * 60_000; // issue it as if 10 minutes in the past
    const token = issueReplyToken("abhi", "a reply", "session-x");
    Date.now = realNow;
    const res = await ttsHandler(ttsRequest({ replyToken: token }, sessionCookieHeader("session-x")));
    expect(res.status).toBe(400);
  });

  it("/api/tts rejects a token minted for a different session, even unexpired", async () => {
    // Issue 11: a token captured from, or shared across, another session
    // must not be redeemable just because it has not expired yet.
    const token = issueReplyToken("abhi", "a reply", "session-x");
    const res = await ttsHandler(ttsRequest({ replyToken: token }, sessionCookieHeader("session-y")));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_token");
  });

  it("/api/tts streams audio for a valid token bound to the requesting session", async () => {
    const fakes = installFakes({ llm: { reply: "ok" } });
    const token = issueReplyToken("abhi", "a reply", "session-x");
    const res = await ttsHandler(ttsRequest({ replyToken: token }, sessionCookieHeader("session-x")));
    expect(res.status).toBe(200);
    expect(fakes.tts.calls.length).toBe(1);
  });

  it("/api/tts rejects a replay of an already-redeemed token", async () => {
    const fakes = installFakes({ llm: { reply: "ok" } });
    const token = issueReplyToken("abhi", "a reply", "session-x");
    const cookie = sessionCookieHeader("session-x");
    const first = await ttsHandler(ttsRequest({ replyToken: token }, cookie));
    expect(first.status).toBe(200);
    const replay = await ttsHandler(ttsRequest({ replyToken: token }, cookie));
    expect(replay.status).toBe(400);
    const body = await replay.json();
    expect(body.error.code).toBe("invalid_token");
    // Only the first redemption reached the provider; the replay must
    // not have re-billed synthesis.
    expect(fakes.tts.calls.length).toBe(1);
  });

  it("an oversize /api/stt body returns 413 and never calls the fake STT", async () => {
    const fakes = installFakes({ stt: { transcript: "x" } });
    const big = new Uint8Array(config.maxSttBytes + 1024);
    const req = new NextRequest("http://localhost:3000/api/stt", {
      method: "POST",
      headers: { "content-length": String(big.length) },
      body: new Blob([big], { type: "audio/webm" }),
    });
    const res = await sttHandler(req);
    expect(res.status).toBe(413);
    expect(fakes.stt.calls.length).toBe(0);
  });

  it("the (N+1)th request inside the window returns 429 with Retry-After, N=3", async () => {
    installFakes({ llm: { reply: "ok" } });
    const cookie = sessionCookieHeader("session-rate-limit");
    const originalMax = config.rateLimitMax;
    config.rateLimitMax = 3;
    try {
      for (let i = 0; i < 3; i++) {
        const res = await chatHandler(
          chatRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] }, cookie)
        );
        expect(res.status).toBe(200);
      }
      const blocked = await chatHandler(
        chatRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] }, cookie)
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).not.toBeNull();
      const body = await blocked.json();
      expect(body.error.code).toBe("rate_limited");
    } finally {
      config.rateLimitMax = originalMax;
    }
  });

  it("chat and tts return 429 once the daily budget is exceeded, but stt still transcribes (finding 2)", async () => {
    // Finding 2 (adversarial review, second pass): /api/stt must never
    // gate transcription itself on the shared daily budget, since the
    // UI is voice-only and calls /api/stt before there is any text to
    // run the crisis check on. A budget-exhausted user's audio (crisis
    // or not) must still come back as a transcript; only what happens
    // AFTER transcription (chat/tts) is allowed to 429 on the budget.
    const fakes = installFakes({ llm: { reply: "ok" }, stt: { transcript: "hello there" } });
    const originalBudget = config.dailyBudgetLlmTokens;
    config.dailyBudgetLlmTokens = 0; // already "exceeded" at zero usage check below
    try {
      // Force the budget check to read as exceeded by recording usage first.
      const { recordLlmUsage } = await import("@/lib/limits");
      recordLlmUsage(1);

      const chatRes = await chatHandler(
        chatRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] })
      );
      expect(chatRes.status).toBe(429);

      const ttsRes = await ttsHandler(
        ttsRequest(
          { replyToken: issueReplyToken("abhi", "x", "session-x") },
          sessionCookieHeader("session-x")
        )
      );
      expect(ttsRes.status).toBe(429);

      const sttRes = await sttHandler(
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        })
      );
      expect(sttRes.status).toBe(200);
      const sttBody = await sttRes.json();
      expect(sttBody.transcript).toBe("hello there");

      expect(fakes.llm.calls.length).toBe(0);
      expect(fakes.tts.calls.length).toBe(0);
      expect(fakes.stt.calls.length).toBe(1);
    } finally {
      config.dailyBudgetLlmTokens = originalBudget;
    }
  });

  it("a crisis message is transcribed and answered even once the daily budget is exhausted (finding 2)", async () => {
    // The exact failure mode finding 2 closes: the UI calls /api/stt
    // first, so a real crisis message must be transcribable and then
    // answered by the crisis backstop, even while the shared daily
    // budget (a cost control) is already fully exhausted.
    const fakes = installFakes({
      llm: { reply: "should never be called for a crisis message" },
      stt: { transcript: "I want to kill myself" },
    });
    const originalBudget = config.dailyBudgetLlmTokens;
    config.dailyBudgetLlmTokens = 0;
    try {
      const { recordLlmUsage } = await import("@/lib/limits");
      recordLlmUsage(1);
      const cookie = sessionCookieHeader("session-budget-crisis");

      const sttRes = await sttHandler(
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          headers: { cookie },
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        })
      );
      expect(sttRes.status).toBe(200);
      const { transcript } = await sttRes.json();
      expect(transcript).toBe("I want to kill myself");

      const chatRes = await chatHandler(
        chatRequest({ personaId: "abhi", messages: [{ role: "user", content: transcript }] }, cookie)
      );
      expect(chatRes.status).toBe(200);
      const { reply, replyToken } = await chatRes.json();
      expect(reply).toContain(config.crisisResources);

      const ttsRes = await ttsHandler(ttsRequest({ replyToken }, cookie));
      expect(ttsRes.status).toBe(200);

      // The model itself was never invoked for the crisis turn.
      expect(fakes.llm.calls.length).toBe(0);
    } finally {
      config.dailyBudgetLlmTokens = originalBudget;
    }
  });

  it("a crisis message still gets a reply even once the daily budget is exceeded", async () => {
    // Issue 1/2/3: budget exhaustion must never be the reason a crisis
    // safety reply does not go out.
    installFakes({ llm: { reply: "ok" } });
    const originalBudget = config.dailyBudgetLlmTokens;
    config.dailyBudgetLlmTokens = 0;
    try {
      const { recordLlmUsage } = await import("@/lib/limits");
      recordLlmUsage(1);
      const res = await chatHandler(
        chatRequest({ personaId: "abhi", messages: [{ role: "user", content: "I want to kill myself" }] })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reply).toContain(config.crisisResources);
    } finally {
      config.dailyBudgetLlmTokens = originalBudget;
    }
  });

  it("a crisis reply's AUDIO still plays through /api/tts once the daily budget is exceeded", async () => {
    // Adversarial-review finding: /api/chat already let a crisis reply's
    // TEXT bypass the budget, but /api/tts still gated the reply's AUDIO
    // on the same exhausted budget, because it had no way to tell a
    // crisis token apart from an ordinary one. This exercises the full
    // chat -> tts flow a real user would hit: ask for help while the
    // shared daily budget is already exhausted (normal operation, not an
    // attack), and confirm the safety reply is actually heard, not just
    // returned as text that the UI then fails to speak.
    const fakes = installFakes({ llm: { reply: "ok" } });
    const originalBudget = config.dailyBudgetLlmTokens;
    const originalTtsBudget = config.dailyBudgetTtsChars;
    config.dailyBudgetLlmTokens = 0;
    config.dailyBudgetTtsChars = 0;
    try {
      const { recordLlmUsage, recordTtsUsage } = await import("@/lib/limits");
      recordLlmUsage(1);
      recordTtsUsage(1);
      const cookie = sessionCookieHeader("session-crisis-audio");

      const chatRes = await chatHandler(
        chatRequest(
          { personaId: "abhi", messages: [{ role: "user", content: "I want to kill myself" }] },
          cookie
        )
      );
      expect(chatRes.status).toBe(200);
      const { reply, replyToken } = await chatRes.json();
      expect(reply).toContain(config.crisisResources);

      const ttsRes = await ttsHandler(ttsRequest({ replyToken }, cookie));
      expect(ttsRes.status).toBe(200);
      expect(fakes.tts.calls.length).toBe(1);
    } finally {
      config.dailyBudgetLlmTokens = originalBudget;
      config.dailyBudgetTtsChars = originalTtsBudget;
    }
  });

  it("an ordinary (non-crisis) reply's audio is still blocked once the daily TTS budget is exceeded", async () => {
    // Confirms the crisis bypass above did not accidentally widen into a
    // general bypass: a non-crisis token must still be rejected.
    const fakes = installFakes({ llm: { reply: "ok" } });
    const originalTtsBudget = config.dailyBudgetTtsChars;
    config.dailyBudgetTtsChars = 0;
    try {
      const { recordTtsUsage } = await import("@/lib/limits");
      recordTtsUsage(1);
      const token = issueReplyToken("abhi", "just an ordinary reply", "session-x");
      const res = await ttsHandler(ttsRequest({ replyToken: token }, sessionCookieHeader("session-x")));
      expect(res.status).toBe(429);
      expect(fakes.tts.calls.length).toBe(0);
    } finally {
      config.dailyBudgetTtsChars = originalTtsBudget;
    }
  });

  it("with VOICE_ENABLED=false, no ElevenLabs call is made", async () => {
    const fakes = installFakes({ llm: { reply: "ok" } });
    const original = config.voiceEnabled;
    config.voiceEnabled = false;
    try {
      const res = await ttsHandler(
        ttsRequest({ replyToken: issueReplyToken("abhi", "x", "session-x") })
      );
      expect(res.status).toBe(503);
      expect(fakes.tts.calls.length).toBe(0);
    } finally {
      config.voiceEnabled = original;
    }
  });

  it("with VOICE_ENABLED=false, /api/stt never calls the fake STT either", async () => {
    // Issue 10: STT previously ignored the kill switch, so Deepgram spend
    // continued even while voice was off everywhere else.
    const fakes = installFakes({ stt: { transcript: "x" } });
    const original = config.voiceEnabled;
    config.voiceEnabled = false;
    try {
      const res = await sttHandler(
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        })
      );
      expect(res.status).toBe(503);
      expect(fakes.stt.calls.length).toBe(0);
    } finally {
      config.voiceEnabled = original;
    }
  });

  it("repeated crisis triggers across chat+tts call the real TTS provider only once (finding 3)", async () => {
    // Cost/abuse finding: the crisis safety reply is a fixed constant
    // per persona, so after the first synthesis it must be served from
    // cache on every subsequent trigger, not re-billed to the real TTS
    // provider. Drives the actual chat -> tts flow three separate times,
    // as three different sessions would, and confirms only the very
    // first one reaches the fake provider.
    const fakes = installFakes({ llm: { reply: "should not matter, crisis short-circuits" } });
    for (let i = 0; i < 3; i++) {
      const cookie = sessionCookieHeader(`session-crisis-cache-${i}`);
      const chatRes = await chatHandler(
        chatRequest(
          { personaId: "abhi", messages: [{ role: "user", content: "I want to kill myself" }] },
          cookie
        )
      );
      expect(chatRes.status).toBe(200);
      const { reply, replyToken } = await chatRes.json();
      expect(reply).toContain(config.crisisResources);

      const ttsRes = await ttsHandler(ttsRequest({ replyToken }, cookie));
      expect(ttsRes.status).toBe(200);
    }
    // All three sessions triggered the identical persona-bound crisis
    // text, so the real provider should have been invoked exactly once.
    expect(fakes.tts.calls.length).toBe(1);
  });

  it("adversarial-review follow-up on finding 6: /api/tts does not rate-limit a crisis reply's audio", async () => {
    // The ordinary rate limit used to run before the reply token (and
    // therefore isCrisis) was even known, so a crisis reply's audio
    // could 429 here under the exact same conditions /api/chat and
    // /api/turn are already protected against for the text. Exhaust the
    // ordinary tts limit first, then confirm a crisis-flagged token
    // still gets through.
    installFakes({ llm: { reply: "should not matter" } });
    const originalMax = config.rateLimitMax;
    config.rateLimitMax = 1;
    try {
      const cookie = sessionCookieHeader("session-tts-crisis-ratelimit");
      const ordinaryToken = issueReplyToken("abhi", "an ordinary reply", "session-tts-crisis-ratelimit");
      const first = await ttsHandler(ttsRequest({ replyToken: ordinaryToken }, cookie));
      expect(first.status).toBe(200);

      // The ordinary per-session limit (1/min) is now exhausted for this
      // session; a second ordinary reply would 429.
      const secondOrdinaryToken = issueReplyToken(
        "abhi",
        "another ordinary reply",
        "session-tts-crisis-ratelimit"
      );
      const blocked = await ttsHandler(ttsRequest({ replyToken: secondOrdinaryToken }, cookie));
      expect(blocked.status).toBe(429);

      // A crisis-flagged token for the SAME session, issued after the
      // limit was already exhausted, must still succeed.
      const crisisToken = issueReplyToken(
        "abhi",
        "I'm concerned about what you just shared.",
        "session-tts-crisis-ratelimit",
        true
      );
      const crisisRes = await ttsHandler(ttsRequest({ replyToken: crisisToken }, cookie));
      expect(crisisRes.status).toBe(200);
    } finally {
      config.rateLimitMax = originalMax;
    }
  });

  it("finding 7: a failed TTS synthesis releases the reply token for a same-token retry", async () => {
    // Before this fix, /api/tts marked a reply token "used" before
    // calling the provider, so a single transient ElevenLabs failure
    // permanently burned the token: the only recourse was a whole new
    // /api/chat round trip. Now a failed synthesis releases the token so
    // the exact same token can be retried once the provider recovers.
    const fakes = installFakes({ llm: { reply: "ok" }, tts: { throwError: "boom" } });
    const token = issueReplyToken("abhi", "a reply", "session-retry");
    const cookie = sessionCookieHeader("session-retry");

    const failed = await ttsHandler(ttsRequest({ replyToken: token }, cookie));
    expect(failed.status).toBe(502);

    // Simulate the provider recovering, then retry with the SAME token.
    fakes.tts.setScript({});
    const retried = await ttsHandler(ttsRequest({ replyToken: token }, cookie));
    expect(retried.status).toBe(200);
    expect(fakes.tts.calls.length).toBe(2); // one failed attempt, one successful retry
  });

  it("adversarial-review follow-up on finding 7: a client-aborted TTS request does not release the token for a free retry", async () => {
    // Releasing the token unconditionally on any synthesis failure let a
    // client manufacture the failure itself by aborting the request
    // after it reached the provider, then retry the same token
    // indefinitely. A client-initiated abort must NOT release the
    // token: it stays spent, same as a genuine success.
    installFakes({ llm: { reply: "ok" }, tts: { throwError: "boom" } });
    const token = issueReplyToken("abhi", "a reply", "session-abort");
    const cookie = sessionCookieHeader("session-abort");
    const controller = new AbortController();
    controller.abort();

    const aborted = await ttsHandler(
      new NextRequest("http://localhost:3000/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ replyToken: token }),
        signal: controller.signal,
      })
    );
    expect(aborted.status).toBe(502);

    // The token must still be reported as already-used: it was never
    // released, so a replay is rejected, not a 502 from the (never
    // reached again) fake provider.
    const retried = await ttsHandler(ttsRequest({ replyToken: token }, cookie));
    expect(retried.status).toBe(400);
    const body = await retried.json();
    expect(body.error.code).toBe("invalid_token");
  });

  it("finding 4: a cookie-less client is rate-limited per-IP, not given a fresh budget every request", async () => {
    // Before finding 4's fix, resolveSession handed a cookie-less request
    // a brand-new random UUID every single time, so the per-session rate
    // limiter (keyed by that id) never actually bound a cookie-less
    // caller: dropping the cookie reset the limiter on every request.
    // Now the id falls back to a stable per-IP key, so the limit is
    // actually enforced across cookie-less requests sharing an IP.
    installFakes({ llm: { reply: "ok" } });
    const originalMax = config.rateLimitMax;
    config.rateLimitMax = 2;
    try {
      const cookielessRequest = () =>
        new NextRequest("http://localhost:3000/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.77",
          },
          body: JSON.stringify({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] }),
        });

      const first = await chatHandler(cookielessRequest());
      expect(first.status).toBe(200);
      const second = await chatHandler(cookielessRequest());
      expect(second.status).toBe(200);
      // Third request from the same IP, still with no cookie at all,
      // must now be blocked rather than getting a fresh budget.
      const third = await chatHandler(cookielessRequest());
      expect(third.status).toBe(429);
    } finally {
      config.rateLimitMax = originalMax;
    }
  });

  it("adversarial-review follow-up on finding 4: harvesting a cookie-less response's cookie does not mint a fresh turn cap", async () => {
    // The first version of the finding-4 fix still issued a fresh random
    // UUID cookie on every cookie-less response. A client could spend
    // its per-IP rate-limit unit once, grab that new cookie, and use it
    // for a brand-new, never-before-seen session with its own fresh
    // 60-turn cap, indefinitely. Confirms a session cap that is actually
    // hit once (not minting a new identity) stays hit even after
    // harvesting and replaying the cookie the server issued.
    installFakes({ llm: { reply: "ok" } });
    const originalMaxTurns = config.maxTurnsPerSession;
    config.maxTurnsPerSession = 1;
    try {
      const cookielessRequest = () =>
        new NextRequest("http://localhost:3000/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.42",
          },
          body: JSON.stringify({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] }),
        });

      const first = await chatHandler(cookielessRequest());
      expect(first.status).toBe(200);
      const issuedCookie = first.headers.get("set-cookie");
      expect(issuedCookie).toBeTruthy();
      const cookieValue = issuedCookie!.split(";")[0];

      // Replaying the cookie the server just issued must NOT reset the
      // turn cap: it already hit 1/1 above, and this cookie resolves to
      // the same ip-bound session, not a new one.
      const replayed = await chatHandler(
        new NextRequest("http://localhost:3000/api/chat", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.42",
            cookie: cookieValue,
          },
          body: JSON.stringify({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] }),
        })
      );
      expect(replayed.status).toBe(429);
    } finally {
      config.maxTurnsPerSession = originalMaxTurns;
    }
  });

  it("finding 4 follow-up: /api/stt uses its own, more generous rate limit so shared-IP crisis transcription is not the first thing to break", async () => {
    const fakes = installFakes({ stt: { transcript: "hello" } });
    const originalMax = config.rateLimitMax;
    const originalSttMax = config.sttRateLimitMax;
    config.rateLimitMax = 2; // the ordinary per-key ceiling, kept low here
    config.sttRateLimitMax = 5; // stt's own, higher ceiling
    try {
      const sttFromSameIp = () =>
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          headers: { "x-forwarded-for": "198.51.100.77" },
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        });

      // More requests than the ordinary rateLimitMax (2), but within
      // sttRateLimitMax (5), must all still succeed.
      for (let i = 0; i < 4; i++) {
        const res = await sttHandler(sttFromSameIp());
        expect(res.status).toBe(200);
      }
      expect(fakes.stt.calls.length).toBe(4);

      // Adversarial-review follow-up: the point of a limit is that it
      // eventually limits something. The 5th request is still within
      // sttRateLimitMax (5)...
      const fifth = await sttHandler(sttFromSameIp());
      expect(fifth.status).toBe(200);
      // ...but the 6th exceeds it and must be rejected, proving this is
      // a real, enforced ceiling and not an unlimited route.
      const sixth = await sttHandler(sttFromSameIp());
      expect(sixth.status).toBe(429);
      expect(fakes.stt.calls.length).toBe(5);
    } finally {
      config.rateLimitMax = originalMax;
      config.sttRateLimitMax = originalSttMax;
    }
  });

  it("finding 1: a crisis message still gets a reply once the message-count cap is exceeded", async () => {
    // Before this fix, validateChatBody's 40-message cap ran BEFORE the
    // crisis check, so a real conversation past ~20 turns (41 messages)
    // got a flat 400 on every later request, crisis or not, and zero
    // safety audio for a genuine crisis message.
    installFakes({ llm: { reply: "should never be called for a crisis message" } });
    const history = Array.from({ length: config.maxChatMessages }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const messages = [...history, { role: "user", content: "I want to kill myself" }];
    expect(messages.length).toBeGreaterThan(config.maxChatMessages);

    const res = await chatHandler(chatRequest({ personaId: "abhi", messages }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toContain(config.crisisResources);
  });

  it("finding 1: a crisis message still gets a reply once the total-character cap is exceeded", async () => {
    installFakes({ llm: { reply: "should never be called for a crisis message" } });
    const paddingMessage = { role: "user" as const, content: "x".repeat(config.maxChatChars) };
    const messages = [paddingMessage, { role: "user" as const, content: "I want to kill myself" }];
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
    expect(totalChars).toBeGreaterThan(config.maxChatChars);

    const res = await chatHandler(chatRequest({ personaId: "abhi", messages }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toContain(config.crisisResources);
  });

  it("finding 1: an oversized NON-crisis body is still rejected by the normal 400 path", async () => {
    // Confirms the loose crisis extraction did not accidentally widen
    // into a general bypass of the size caps for ordinary conversation.
    installFakes({ llm: { reply: "ok" } });
    const history = Array.from({ length: config.maxChatMessages + 1 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const res = await chatHandler(chatRequest({ personaId: "abhi", messages: history }));
    expect(res.status).toBe(400);
  });

  it("logs for a full turn contain no transcript or reply text", async () => {
    const fixtureTranscript = "this exact transcript must never be logged";
    const fixtureReply = "this exact reply must never be logged";
    installFakes({ stt: { transcript: fixtureTranscript }, llm: { reply: fixtureReply } });
    const cookie = sessionCookieHeader("session-full-turn");

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const sttRes = await sttHandler(
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          headers: { cookie },
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        })
      );
      const { transcript } = await sttRes.json();

      const chatRes = await chatHandler(
        chatRequest({ personaId: "abhi", messages: [{ role: "user", content: transcript }] }, cookie)
      );
      const { replyToken } = await chatRes.json();

      const ttsRes = await ttsHandler(ttsRequest({ replyToken }, cookie));
      expect(ttsRes.status).toBe(200);
    } finally {
      console.log = originalLog;
    }

    const allLogs = logged.join("\n");
    expect(allLogs).not.toContain(fixtureTranscript);
    expect(allLogs).not.toContain(fixtureReply);
  });
});
