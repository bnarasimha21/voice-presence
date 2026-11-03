import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DeepgramSttProvider } from "@/lib/providers/real/stt";

// Finding 2 (third adversarial review): the real Deepgram provider used
// to hardcode `language=en` on every transcription call. The UI is
// voice-only, so a Spanish or Hindi speaker in genuine crisis was
// transcribed as garbled English text that could never match the
// Spanish/Devanagari crisis patterns in lib/personas/prompt.ts. This
// exercises the real provider class directly (not the fake, which never
// builds a URL at all) against a mocked fetch, to confirm the fix
// actually requests language auto-detection instead of forcing English.

describe("DeepgramSttProvider language handling", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.DEEPGRAM_API_KEY;

  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = "test-deepgram-key";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    // Finding 7 (fourth adversarial review): assigning `undefined` to a
    // process.env property coerces it to the literal string "undefined"
    // rather than deleting it, since process.env values are always
    // strings. If DEEPGRAM_API_KEY was unset before this suite ran,
    // the old `process.env.DEEPGRAM_API_KEY = originalKey` line would
    // leave it set to the string "undefined" afterward instead of
    // restoring "unset", leaking state into later tests/files.
    if (originalKey === undefined) {
      delete process.env.DEEPGRAM_API_KEY;
    } else {
      process.env.DEEPGRAM_API_KEY = originalKey;
    }
  });

  function mockFetchOk(body: unknown) {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return calls;
  }

  it("requests automatic language detection instead of forcing English", async () => {
    const calls = mockFetchOk({
      results: { channels: [{ alternatives: [{ transcript: "hola mundo" }] }] },
      metadata: { duration: 1.2 },
    });

    const provider = new DeepgramSttProvider();
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const result = await provider.transcribe({ audio, model: "nova-2" });

    expect(result.transcript).toBe("hola mundo");
    expect(calls).toHaveLength(1);
    const requestedUrl = new URL(calls[0]);
    expect(requestedUrl.searchParams.get("detect_language")).toBe("true");
    // The old hardcoded value must be gone entirely, not merely
    // overridden alongside detect_language.
    expect(requestedUrl.searchParams.has("language")).toBe(false);
  });

  it("still transcribes English speech normally with detection enabled", async () => {
    mockFetchOk({
      results: { channels: [{ alternatives: [{ transcript: "hello there" }] }] },
      metadata: { duration: 1.0 },
    });

    const provider = new DeepgramSttProvider();
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const result = await provider.transcribe({ audio, model: "nova-2" });

    expect(result.transcript).toBe("hello there");
  });
});
