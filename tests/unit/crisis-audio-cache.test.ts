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

// Finding 5 (third adversarial review, floor raised again in the fourth
// after 20 bytes/char turned out to be "theater"): getCachedCrisisAudio
// now rejects a synthesis result that is short relative to the input
// text's length. The PRIMARY mechanism (lib/crisis-audio-cache.ts,
// minExpectedBytes/bytesPerSecondForOutputFormat) derives the floor from
// the actual output format's bitrate or sample rate and
// config.assumedMaxSpeakingCharsPerSecond (default 20); see the
// "bitrate-aware" tests further down for that path.
// config.minCrisisAudioBytesPerChar (default 300 bytes/char) is only the
// FALLBACK used when the output format string can't be parsed into a
// known bitrate/sample rate -- which is exactly the case for the
// existing tests in this block, since they pass the deliberately
// unparseable outputFormat: "mp3" literal. Those tests use args.text =
// "safety reply" (12 characters, so the fallback floor is 3600 bytes),
// so the "successful" fixture below must be large enough to clear that
// floor; it does not need to resemble real audio otherwise.
const sampleBytes = new TextEncoder().encode("fake audio bytes".repeat(300));

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

  // Finding 5 (third adversarial review): the old check only rejected a
  // literal zero-length body. A stream that ends early but CLEANLY
  // (e.g. cut off mid-sentence, before a "call 988" line) is nonzero
  // length and used to be cached as if it were the real, complete
  // safety audio, then served forever on every later crisis trigger.
  it("does not cache a nonzero-length body that is far shorter than expected for the text, and the next call retries", async () => {
    let calls = 0;
    // A deliberately truncated body: only a handful of bytes for text
    // long enough that real (or this suite's realistically-sized fake)
    // audio would be much larger.
    const truncatedBytes = new TextEncoder().encode("cut off");
    const args = {
      text: "I'm concerned about what you just shared. I'm an AI, and I can't provide the kind of help you may need right now.",
      voiceId: "v1",
      model: "m1",
      outputFormat: "mp3",
    };
    // A full-size fixture, proportioned for THIS test's (longer) text,
    // not the shared `sampleBytes` fixture above which is only sized for
    // the 12-character "safety reply" text used elsewhere in this file.
    // args.text is 115 chars, so the floor is 115 * 300 = 34,500 bytes;
    // this fixture clears it with margin.
    const fullSizeBytes = new TextEncoder().encode("full audio ".repeat(5000));
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        calls += 1;
        if (calls === 1) return { stream: streamOf(truncatedBytes), contentType: "audio/mpeg" };
        return { stream: streamOf(fullSizeBytes), contentType: "audio/mpeg" };
      },
    };

    await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow(/truncated/);
    expect(crisisAudioCacheSize()).toBe(0);

    const retried = await getCachedCrisisAudio(tts, args);
    expect(calls).toBe(2);
    expect(retried.bytes).toEqual(fullSizeBytes);
    expect(crisisAudioCacheSize()).toBe(1);
  });

  // Adversarial-review follow-up (fourth pass): the test above only
  // proves a near-empty body is rejected, which almost any positive
  // floor would catch and says nothing about whether the floor is
  // actually sized to catch a realistic partial truncation (e.g. audio
  // that plays most of the reply but drops the final clause/resources
  // line). This uses a body sized to a fraction of the real floor for a
  // much longer, more realistic safety-reply-length text, so it fails
  // specifically because of the bytes-per-char comparison, not because
  // the body is implausibly tiny.
  //
  // Finding 3 (fourth adversarial review, second pass): the original
  // version of this test derived `partialBytes` from
  // `config.minCrisisAudioBytesPerChar` itself, so it passed for ANY
  // positive floor, including the old, too-low flat 20, and never
  // exercised the bitrate-aware calculation in
  // lib/crisis-audio-cache.ts's minExpectedBytes(). This version ties
  // the fixture size to a real output format's bitrate instead: at the
  // default "mp3_44100_128" (128 kbps = 16,000 bytes/sec), typical
  // complete speech runs to roughly 1,200-1,300 bytes/char, so a stream
  // that produced real audio for only the first third or so of the
  // reply (dropping the trailing resources sentence) is a realistic
  // partial cut, not an all-or-nothing failure.
  it("rejects a body that is a plausible partial cut at the real default bitrate, not just a near-empty one", async () => {
    const text =
      "I'm concerned about what you just shared, and I want to take it seriously. " +
      "I'm an AI, and I'm not able to provide the kind of support you may need right now. " +
      "Please reach out to people who can help.";
    const typicalBytesPerChar = 1250; // roughly 128kbps / ~12.8 chars/sec
    const partialBytes = new Uint8Array(Math.floor(text.length * typicalBytesPerChar * 0.34));
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(partialBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text, voiceId: "v1", model: "m1", outputFormat: "mp3_44100_128" };

    await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow(/truncated/);
    expect(crisisAudioCacheSize()).toBe(0);
  });

  // Finding 1 (fourth adversarial review, second pass): a flat
  // bytes-per-char floor sized for the default 128kbps format falsely
  // rejected genuinely COMPLETE audio at a lower-bitrate output format,
  // since full audio there is naturally fewer bytes/char. The
  // bitrate-aware floor must not repeat that: complete, untruncated
  // audio at a real low-bitrate format must still be accepted.
  it("accepts a complete body at a low-bitrate output format (does not regress the finding 1 false-reject)", async () => {
    const text = "safety reply";
    // mp3_44100_32 = 32kbps = 4,000 bytes/sec; a realistic ~14 chars/sec
    // speaking rate gives full audio of roughly 286 bytes/char.
    const fullBytesAtLowBitrate = new Uint8Array(Math.ceil(text.length * 286));
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(fullBytesAtLowBitrate), contentType: "audio/mpeg" };
      },
    };
    const args = { text, voiceId: "v1", model: "m1", outputFormat: "mp3_44100_32" };

    const result = await getCachedCrisisAudio(tts, args);
    expect(result.bytes).toEqual(fullBytesAtLowBitrate);
  });

  // Finding 2 (fourth adversarial review, third pass): opus and a-law
  // output formats used to fall through to the flat fallback floor,
  // which reopens the exact false-reject this module exists to avoid for
  // those formats. These confirm opus is now bitrate-aware: a realistic
  // complete body at opus's real bitrate is accepted, and a body cut to
  // a fraction of that is rejected as truncated.
  it("accepts a complete body at an opus output format, and rejects a truncated one at the same format", async () => {
    const text = "safety reply";
    // opus_48000_32 = 32kbps = 4,000 bytes/sec; same bytes/sec math as
    // mp3 at the same kbps, so full audio at a realistic speaking rate
    // again runs to roughly 286 bytes/char.
    const fullBytes = new Uint8Array(Math.ceil(text.length * 286));
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(fullBytes), contentType: "audio/ogg" };
      },
    };
    const args = { text, voiceId: "v1", model: "m1", outputFormat: "opus_48000_32" };
    const result = await getCachedCrisisAudio(tts, args);
    expect(result.bytes).toEqual(fullBytes);

    // A body cut to roughly a third of that is a realistic partial cut
    // at this bitrate, not just a near-empty body, and must still fail.
    const partialBytes = new Uint8Array(Math.floor(fullBytes.length * 0.34));
    const ttsPartial: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(partialBytes), contentType: "audio/ogg" };
      },
    };
    await expect(
      getCachedCrisisAudio(ttsPartial, { ...args, voiceId: "v2" })
    ).rejects.toThrow(/truncated/);
  });

  // Finding 3 (fourth adversarial review, third pass): a malformed
  // output format string that still matches the mp3 pattern but carries
  // a nonsensical kbps of 0 (e.g. a typo'd env-configured format) used to
  // make bytesPerSecondForOutputFormat return 0, which made
  // minExpectedBytes return 0 too -- a floor of zero accepts literally
  // any nonzero body, silently disabling the truncation check entirely.
  // It must instead fall back to the flat, still-positive
  // minCrisisAudioBytesPerChar floor, so a near-empty body at this
  // malformed format is still caught.
  it("falls back to the flat floor instead of a zero floor when the output format has a nonsensical zero kbps", async () => {
    const text = "safety reply";
    const nearEmptyBytes = new Uint8Array(1);
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(nearEmptyBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text, voiceId: "v1", model: "m1", outputFormat: "mp3_44100_0" };
    await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow(/truncated/);
  });

  // Finding 3 (fourth adversarial review, third pass), continued: a
  // misconfigured ASSUMED_MAX_SPEAKING_CHARS_PER_SECOND of 0 (or
  // negative) used to divide bytesPerSecond by zero/negative, producing
  // Infinity or a negative floor -- either disables the check (nothing
  // clears an Infinity floor) or breaks crisis audio outright (a
  // negative floor some environments might still reject against, or
  // which signals a broken config). It must fall back to a sane default
  // instead of propagating the bad value into the arithmetic.
  it("falls back to a sane default speaking rate instead of dividing by zero when misconfigured", async () => {
    const originalRate = config.assumedMaxSpeakingCharsPerSecond;
    config.assumedMaxSpeakingCharsPerSecond = 0;
    try {
      const text = "safety reply";
      const nearEmptyBytes = new Uint8Array(1);
      const tts: TtsProvider = {
        async synthesize(): Promise<TtsResult> {
          return { stream: streamOf(nearEmptyBytes), contentType: "audio/mpeg" };
        },
      };
      const args = { text, voiceId: "v1", model: "m1", outputFormat: "mp3_44100_128" };
      // A 1-byte body must still be rejected: if the zero config value
      // had been used directly, dividing by it would produce Infinity
      // (still rejects, coincidentally) or, with a negative value,
      // a negative/zero floor that would wrongly accept this body. The
      // real assertion is in the next test, which proves a genuinely
      // complete body is still accepted (i.e. the fallback rate is a
      // real, finite, positive number, not Infinity).
      await expect(getCachedCrisisAudio(tts, args)).rejects.toThrow(/truncated/);
    } finally {
      config.assumedMaxSpeakingCharsPerSecond = originalRate;
    }
  });

  it("still accepts a genuinely complete body when the speaking-rate config is misconfigured to zero", async () => {
    const originalRate = config.assumedMaxSpeakingCharsPerSecond;
    config.assumedMaxSpeakingCharsPerSecond = 0;
    try {
      const text = "safety reply";
      // Full audio at 128kbps and a realistic ~13 chars/sec speaking
      // rate: comfortably above any sane fallback floor.
      const fullBytes = new Uint8Array(Math.ceil(text.length * 1230));
      const tts: TtsProvider = {
        async synthesize(): Promise<TtsResult> {
          return { stream: streamOf(fullBytes), contentType: "audio/mpeg" };
        },
      };
      const args = { text, voiceId: "v1", model: "m1", outputFormat: "mp3_44100_128" };
      const result = await getCachedCrisisAudio(tts, args);
      expect(result.bytes).toEqual(fullBytes);
    } finally {
      config.assumedMaxSpeakingCharsPerSecond = originalRate;
    }
  });

  it("accepts a body that is realistically sized for the text's length", async () => {
    // Confirms the new floor does not itself start rejecting a normal,
    // complete synthesis result: sampleBytes (17 * 300 = 5,100 bytes)
    // comfortably clears the floor for this short "safety reply" text
    // at the unparseable "mp3" format used by this fixture (falls back
    // to the flat config.minCrisisAudioBytesPerChar).
    const tts: TtsProvider = {
      async synthesize(): Promise<TtsResult> {
        return { stream: streamOf(sampleBytes), contentType: "audio/mpeg" };
      },
    };
    const args = { text: "safety reply", voiceId: "v1", model: "m1", outputFormat: "mp3" };
    const result = await getCachedCrisisAudio(tts, args);
    expect(result.bytes).toEqual(sampleBytes);
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
