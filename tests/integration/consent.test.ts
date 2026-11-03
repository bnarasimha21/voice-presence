import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as chatHandler } from "@/app/api/chat/route";
import { POST as ttsHandler } from "@/app/api/tts/route";
import { installFakes } from "./helpers";
import { issueReplyToken } from "@/lib/turn-token";

// Issue 3 acceptance: real route handlers, fake providers, one persona
// with valid consent ("abhi") and one with pending (not yet granted)
// consent ("sam", registered in the manifest for this exact purpose).
// Asserts the allowed and 403 paths, and that the pending-consent
// persona never reaches the fake TTS.

function chatRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ttsRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("persona consent enforcement (issue 3)", () => {
  it("the valid-consent persona (abhi) is allowed through /api/chat and /api/tts", async () => {
    const fakes = installFakes({ llm: { reply: "hi there" } });
    const chatRes = await chatHandler(
      chatRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] })
    );
    expect(chatRes.status).toBe(200);
    const { replyToken } = await chatRes.json();

    const ttsRes = await ttsHandler(ttsRequest({ replyToken }));
    expect(ttsRes.status).toBe(200);
    expect(fakes.tts.calls.length).toBe(1);
  });

  it("the pending-consent persona (sam) is rejected by /api/chat with 403", async () => {
    installFakes({ llm: { reply: "hi there" } });
    const res = await chatHandler(
      chatRequest({ personaId: "sam", messages: [{ role: "user", content: "hi" }] })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("persona_unavailable");
  });

  it("the pending-consent persona (sam) is rejected by /api/tts and never reaches the fake TTS", async () => {
    const fakes = installFakes({ llm: { reply: "hi there" } });
    const res = await ttsHandler(
      ttsRequest({ replyToken: issueReplyToken("sam", "hello") })
    );
    expect(res.status).toBe(403);
    expect(fakes.tts.calls.length).toBe(0);
  });

  it("an unknown persona id is rejected by /api/tts before any provider call", async () => {
    const fakes = installFakes({ llm: { reply: "hi there" } });
    const res = await ttsHandler(
      ttsRequest({ replyToken: issueReplyToken("nonexistent-persona", "hello") })
    );
    expect(res.status).toBe(400);
    expect(fakes.tts.calls.length).toBe(0);
  });
});
