import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedCrisisAudio,
  resetCrisisAudioCache,
  crisisAudioCacheSize,
} from "@/lib/crisis-audio-cache";
import { config } from "@/lib/config";
import type { TtsProvider, TtsRequest, TtsResult } from "@/lib/providers/types";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

const sampleBytes = new TextEncoder().encode("fake audio bytes");

beforeEach(() => {
  resetCrisisAudioCache();
});

describe("getCachedCrisisAudio", () => {
  it("synthesizes once and serves subsequent calls from the cache", async () => {
    let calls = 0;
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        calls += 1;
        return { stream: streamOf(sampleBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text: "safety reply", voiceId: "v1", model: "m1", outputFormat: "mp3" };

    const first = await getCachedCrisisAudio(tts, args);
    const second = await getCachedCrisisAudio(tts, args);

    expect(calls).toBe(1);
    expect(first.bytes).toEqual(second.bytes);
    expect(crisisAudioCacheSize()).toBe(1);
  });

  it("dedupes concurrent first-use calls behind a single in-flight synthesis", async () => {
    let calls = 0;
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { stream: streamOf(sampleBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text: "safety reply", voiceId: "v1", model: "m1", outputFormat: "mp3" };

    const [a, b, c] = await Promise.all([
      getCachedCrisisAudio(tts, args),
      getCachedCrisisAudio(tts, args),
      getCachedCrisisAudio(tts, args),
    ]);

    expect(calls).toBe(1);
    expect(a.bytes).toEqual(b.bytes);
    expect(b.bytes).toEqual(c.bytes);
  });

  // Adversarial-review follow-up on finding 3: an empty/truncated 200
  // must not be cached, or every future crisis trigger for that key
  // would be served silence forever.
  it("does not cache an empty-body synthesis result, and the next call retries", async () => {
    let calls = 0;
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        calls += 1;
        if (calls === 1) return { stream: streamOf(new Uint8Array(0)), contentType: "audio/mpeg" };
        return { stream: streamOf(sampleBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text: "safety reply", voiceId: "v1", model: "m1", outputFormat: "mp3" };

    await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow();
    expect(crisisAudioCacheSize()).toBe(0);

    const retried = await getCachedCrisisAudio(tts, args);
    expect(calls).toBe(2);
    expect(retried.bytes).toEqual(sampleBytes);
    expect(crisisAudioCacheSize()).toBe(1);
  });

  // Adversarial-review follow-up on finding 3: dedup means a single
  // stalled synthesis call used to block every crisis trigger (any
  // session, not just the first caller) for as long as the provider
  // hung. A bounded timeout means it fails fast instead, freeing the key
  // for the next caller's own attempt.
  it("gives up on a synthesis call that exceeds the configured timeout, instead of blocking every caller forever", async () => {
    const originalTimeout = config.crisisAudioTimeoutMs;
    config.crisisAudioTimeoutMs = 20;
    try {
      let calls = 0;
      const tts: TtsProvider = {
        async synthesize(req: TtsRequest): Promise<TtsResult> {
          calls += 1;
          if (calls === 1) {
            // Never resolves on its own; only the abort signal ends it.
            await new Promise<void>((resolve, reject) => {
              req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
            throw new Error("unreachable");
          }
          return { stream: streamOf(sampleBytes), contentType: "audio/mpeg" };
        },
      };
      const args = { text: "safety reply", voiceId: "v1", model: "m1", outputFormat: "mp3" };

      await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow();
      expect(crisisAudioCacheSize()).toBe(0);

      const retried = await getCachedCrisisAudio(tts, args);
      expect(retried.bytes).toEqual(sampleBytes);
    } finally {
      config.crisisAudioTimeoutMs = originalTimeout;
    }
  });
});
