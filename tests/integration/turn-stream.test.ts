import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as turnHandler } from "@/app/api/turn/route";
import { installFakes } from "./helpers";
import { config } from "@/lib/config";

// Issue 4 acceptance: a single streaming turn through the real route
// handler, fake providers, no network. Checks the NDJSON event contract
// and that audio for an earlier sentence is emitted before the stream
// finishes receiving later text, which is the whole point of chunked
// synthesis instead of waiting for the full reply.

function turnRequest(body: unknown) {
  return new NextRequest("http://localhost:3000/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readNdjson(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Record<string, unknown>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

describe("streaming turn (issue 4)", () => {
  it("streams text deltas, then per-sentence audio, then a done event with timing", async () => {
    installFakes({ llm: { reply: "One. Two. Three." } });
    const res = await turnHandler(
      turnRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("x-ndjson");

    const events = await readNdjson(res.body!);
    const types = events.map((e) => e.type);

    expect(types).toContain("text_delta");
    expect(types).toContain("audio");
    expect(types.at(-1)).toBe("done");

    const done = events.at(-1)!;
    expect(typeof done.reply).toBe("string");
    expect(done.timing).toHaveProperty("turn_start");
    expect(done.timing).toHaveProperty("first_sentence");
    expect(done.timing).toHaveProperty("turn_done");

    const audioCount = events.filter((e) => e.type === "audio").length;
    // Three sentences in, three sentences spoken out.
    expect(audioCount).toBe(3);
  });

  it("emits audio for the first sentence before the text stream finishes, when the model is slow", async () => {
    installFakes({ llm: { reply: "First sentence. Second sentence. Third sentence.", deltaDelayMs: 5 } });
    const res = await turnHandler(
      turnRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] })
    );
    const events = await readNdjson(res.body!);

    const firstAudioIndex = events.findIndex((e) => e.type === "audio");
    const lastTextDeltaIndex = events.map((e) => e.type).lastIndexOf("text_delta");

    expect(firstAudioIndex).toBeGreaterThan(-1);
    expect(firstAudioIndex).toBeLessThan(lastTextDeltaIndex);
  });

  it("rejects an unusable persona with 403 before calling any provider", async () => {
    const fakes = installFakes({ llm: { reply: "hi" } });
    const res = await turnHandler(
      turnRequest({ personaId: "sam", messages: [{ role: "user", content: "hi" }] })
    );
    expect(res.status).toBe(403);
    expect(fakes.llm.calls.length).toBe(0);
    expect(fakes.tts.calls.length).toBe(0);
  });

  it("emits an error event and closes the stream when the LLM provider fails", async () => {
    installFakes({ llm: { throwError: "boom" } });
    const res = await turnHandler(
      turnRequest({ personaId: "abhi", messages: [{ role: "user", content: "hi" }] })
    );
    expect(res.status).toBe(200); // headers already sent before the stream body fails
    const events = await readNdjson(res.body!);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.code).toBe("provider_error");
  });

  it("rejects an invalid body with 400 before opening a stream", async () => {
    installFakes({ llm: { reply: "hi" } });
    const res = await turnHandler(turnRequest({ personaId: "abhi", messages: [] }));
    expect(res.status).toBe(400);
  });

  it("finding 1: a crisis message still streams a safety reply once the message-count cap is exceeded", async () => {
    const fakes = installFakes({ llm: { reply: "should never be called for a crisis message" } });
    const history = Array.from({ length: config.maxChatMessages }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const messages = [...history, { role: "user", content: "I want to kill myself" }];
    expect(messages.length).toBeGreaterThan(config.maxChatMessages);

    const res = await turnHandler(turnRequest({ personaId: "abhi", messages }));
    expect(res.status).toBe(200);
    const events = await readNdjson(res.body!);
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.reply as string).toContain(config.crisisResources);
    expect(fakes.llm.calls.length).toBe(0);
    // Finding 4 (fourth adversarial review): asserting on `done.reply`
    // alone would not catch a silent crisis-TTS failure, since the route
    // swallows a synthesis error and still emits `done` with the correct
    // text. The safety reply is also meant to be spoken, not just
    // streamed as text, so the audio event must actually be present.
    expect(events.map((e) => e.type)).toContain("audio");
    expect(fakes.tts.calls.length).toBeGreaterThan(0);
  });

  it("finding 1: a crisis message still streams a safety reply once the total-character cap is exceeded", async () => {
    const fakes = installFakes({ llm: { reply: "should never be called for a crisis message" } });
    const paddingMessage = { role: "user" as const, content: "x".repeat(config.maxChatChars) };
    const messages = [paddingMessage, { role: "user" as const, content: "I want to kill myself" }];
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
    expect(totalChars).toBeGreaterThan(config.maxChatChars);

    const res = await turnHandler(turnRequest({ personaId: "abhi", messages }));
    expect(res.status).toBe(200);
    const events = await readNdjson(res.body!);
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.reply as string).toContain(config.crisisResources);
    expect(fakes.llm.calls.length).toBe(0);
    expect(events.map((e) => e.type)).toContain("audio");
    expect(fakes.tts.calls.length).toBeGreaterThan(0);
  });

  // Finding 1 follow-up (fourth adversarial review): the loose
  // extraction that lets the crisis check see an oversized body is
  // itself bounded (lib/validate.ts, LOOSE_MAX_MESSAGES /
  // LOOSE_MAX_MESSAGE_CHARS -- see tests/unit/validate.test.ts for the
  // precise boundary behavior), so an attacker cannot use "it's a
  // crisis message" as a way to force unbounded regex work. This is the
  // end-to-end check that a crisis phrase near the end of an oversized
  // single message still produces the full safety reply, text AND
  // audio, through the real route handler.
  it("finding 1 follow-up: a crisis phrase still matches near the end of an oversized single message", async () => {
    const fakes = installFakes({ llm: { reply: "should never be called for a crisis message" } });
    const padding = "x".repeat(100_000);
    const messages = [
      { role: "user" as const, content: `${padding} I want to kill myself` },
    ];

    const res = await turnHandler(turnRequest({ personaId: "abhi", messages }));
    expect(res.status).toBe(200);
    const events = await readNdjson(res.body!);
    const done = events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.reply as string).toContain(config.crisisResources);
    expect(fakes.llm.calls.length).toBe(0);
    expect(events.map((e) => e.type)).toContain("audio");
    expect(fakes.tts.calls.length).toBeGreaterThan(0);
  });

  it("finding 1: an oversized NON-crisis body is still rejected by the normal 400 path", async () => {
    installFakes({ llm: { reply: "ok" } });
    const history = Array.from({ length: config.maxChatMessages + 1 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const res = await turnHandler(turnRequest({ personaId: "abhi", messages: history }));
    expect(res.status).toBe(400);
  });
});
