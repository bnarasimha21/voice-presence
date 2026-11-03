import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as sttHandler } from "@/app/api/stt/route";
import { POST as chatHandler } from "@/app/api/chat/route";
import { POST as ttsHandler } from "@/app/api/tts/route";
import { installFakes, readAllBytes } from "./helpers";

// Issue 1 acceptance: a fixture audio blob through /api/stt, the
// transcript through /api/chat, and the reply through /api/tts (all on
// fake providers) produces a transcript, a non-empty reply and non-empty
// audio bytes with audio/mpeg. This also exercises the issue 2 token
// contract between /api/chat and /api/tts.

function sttRequest(blob: Blob) {
  return new NextRequest("http://localhost:3000/api/stt", {
    method: "POST",
    body: blob,
  });
}

function chatRequest(personaId: string, messages: unknown[]) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId, messages }),
  });
}

function ttsRequest(replyToken: string) {
  return new NextRequest("http://localhost:3000/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replyToken }),
  });
}

describe("full turn: stt -> chat -> tts on fake providers", () => {
  beforeEach(() => {
    installFakes({
      stt: { transcript: "hello there, how are you" },
      llm: { reply: "I'm glad you're here. Tell me more." },
    });
  });

  it("produces a transcript, a non-empty reply and non-empty mpeg audio", async () => {
    const fixtureAudio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });

    const sttRes = await sttHandler(sttRequest(fixtureAudio));
    expect(sttRes.status).toBe(200);
    const { transcript } = await sttRes.json();
    expect(transcript).toBe("hello there, how are you");

    const chatRes = await chatHandler(
      chatRequest("abhi", [{ role: "user", content: transcript }])
    );
    expect(chatRes.status).toBe(200);
    const { reply, replyToken } = await chatRes.json();
    expect(reply.length).toBeGreaterThan(0);
    expect(typeof replyToken).toBe("string");

    const ttsRes = await ttsHandler(ttsRequest(replyToken));
    expect(ttsRes.status).toBe(200);
    expect(ttsRes.headers.get("content-type")).toBe("audio/mpeg");
    expect(ttsRes.headers.get("x-ai-generated-voice")).toBe("true");

    const bytes = await readAllBytes(ttsRes.body as ReadableStream<Uint8Array>);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
