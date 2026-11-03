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

  it("all three routes return 429 once the daily budget is exceeded", async () => {
    const fakes = installFakes({ llm: { reply: "ok" } });
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
        ttsRequest({ replyToken: issueReplyToken("abhi", "x", "session-x") })
      );
      expect(ttsRes.status).toBe(429);

      const sttRes = await sttHandler(
        new NextRequest("http://localhost:3000/api/stt", {
          method: "POST",
          body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
        })
      );
      expect(sttRes.status).toBe(429);

      expect(fakes.llm.calls.length).toBe(0);
      expect(fakes.tts.calls.length).toBe(0);
      expect(fakes.stt.calls.length).toBe(0);
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
