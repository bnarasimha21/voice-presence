// Adversarial-review finding (cost/abuse): the crisis safety reply is the
// same fixed, constant text for a given persona every single time it
// trips (see crisisSafetyReply() in lib/personas/prompt.ts), so there is
// no reason to pay ElevenLabs to synthesize it again on every trigger.
// Before this module, "kms" sent repeatedly was an unmetered, unlimited
// TTS endpoint: the crisis path is deliberately exempt from the daily
// budget and the reply-token's normal single-use rule (see /api/turn and
// /api/tts), which is correct for safety but meant it was also exempt
// from ever being rate-limited by cost.
//
// Fix: synthesize the constant safety reply once per persona voice, cache
// the resulting audio bytes in memory, and serve the cached bytes on
// every subsequent trigger instead of calling the real provider again.
// This removes the cost issue and, as a side effect, makes the safety
// path robust to a transient TTS provider failure after the first
// successful fill: a cached crisis reply never depends on the provider
// being up.
//
// Concurrent first-use calls (two different sessions both trip the
// crisis path before either synthesis completes) are deduplicated via an
// in-flight promise map, so a burst of simultaneous crisis triggers still
// only ever calls the real provider once per persona voice.

import { config } from "@/lib/config";
import type { TtsProvider } from "@/lib/providers/types";

export type CachedCrisisAudio = {
  bytes: Uint8Array;
  contentType: string;
};

const cache = new Map<string, CachedCrisisAudio>();
const pending = new Map<string, Promise<CachedCrisisAudio>>();

function cacheKey(voiceId: string, text: string, model: string, outputFormat: string): string {
  return `${voiceId}::${model}::${outputFormat}::${text}`;
}

// Finding 5 follow-up (fourth adversarial review, second pass): a single
// flat bytes-per-char floor cannot both (a) never false-reject complete
// audio at a low-bitrate output format and (b) still catch a realistic
// partial truncation at the default, much higher-bitrate format: those
// pull the one constant in opposite directions. Deriving expected
// bytes/char from the ACTUAL output format's bitrate (or sample rate for
// uncompressed formats) fixes both at once. Covers the ElevenLabs output
// format families this app actually uses or is likely to be configured
// with; an unrecognized format string falls back to the flat
// config.minCrisisAudioBytesPerChar instead of guessing.
// Finding 2 (fourth adversarial review, third pass): the first version
// of this only recognized mp3/pcm/ulaw, so ElevenLabs' opus and a-law
// output formats fell through to the flat fallback floor, reopening the
// exact false-reject this function exists to avoid (e.g. opus_48000_32's
// complete audio legitimately runs close to, or below, a flat 300
// bytes/char fallback). Added so every output format family ElevenLabs
// actually offers is bitrate-aware, not just the ones already in use.
function bytesPerSecondForOutputFormat(outputFormat: string): number | null {
  // A kbps (or sample rate) of 0 or negative is nonsensical input, not a
  // real format; treat it the same as "unrecognized" rather than
  // returning 0, which would make every synthesis result pass (anything
  // is >= a 0 floor), silently disabling this check entirely.
  const positive = (n: number) => (Number.isFinite(n) && n > 0 ? n : null);

  const mp3 = outputFormat.match(/^mp3_\d+_(\d+)$/);
  if (mp3) {
    const kbps = positive(Number(mp3[1]));
    return kbps === null ? null : (kbps * 1000) / 8;
  }
  const opus = outputFormat.match(/^opus_\d+_(\d+)$/);
  if (opus) {
    const kbps = positive(Number(opus[1]));
    return kbps === null ? null : (kbps * 1000) / 8;
  }
  // Uncompressed 16-bit mono PCM: 2 bytes per sample.
  const pcm = outputFormat.match(/^pcm_(\d+)$/);
  if (pcm) {
    const sampleRate = positive(Number(pcm[1]));
    return sampleRate === null ? null : sampleRate * 2;
  }
  // mu-law / a-law: 1 byte per sample.
  const ulaw = outputFormat.match(/^ulaw_(\d+)$/);
  if (ulaw) {
    return positive(Number(ulaw[1]));
  }
  const alaw = outputFormat.match(/^alaw_(\d+)$/);
  if (alaw) {
    return positive(Number(alaw[1]));
  }
  return null;
}

// Finding 1 (fourth adversarial review, third pass): with the previous
// assumedMaxSpeakingCharsPerSecond of 25, the floor only caught a stream
// that lost more than roughly half the expected audio. A stream that
// produced real audio for the first ~79% of the reply and then dropped
// only the final "call 988" resources sentence (roughly its last fifth)
// stayed above that floor and was still cached as if complete, which is
// close to the exact failure this check exists to catch. Lowered to 16
// (still comfortably above a typical spoken rate of ~12-13 chars/sec,
// so a genuinely complete reading at a brisk pace is not mistaken for
// truncated) to tighten the margin and actually catch that case; this
// remains a heuristic, not an exact decode, and an unusually fast voice
// configuration should widen ASSUMED_MAX_SPEAKING_CHARS_PER_SECOND via
// env rather than rely on the default blindly.
function minExpectedBytes(text: string, outputFormat: string): number {
  const bytesPerSecond = bytesPerSecondForOutputFormat(outputFormat);
  const charsPerSecondConfigured = config.assumedMaxSpeakingCharsPerSecond;
  const charsPerSecondValid = Number.isFinite(charsPerSecondConfigured) && charsPerSecondConfigured > 0;
  // Finding 3 (fourth adversarial review, third pass): a misconfigured
  // env value (0, negative, or NaN) is silently swapped for the same
  // safe default used elsewhere -- correct, but silent substitution of a
  // safety-relevant setting is itself worth surfacing, since nothing
  // else would ever tell an operator their env var is being ignored.
  if (!charsPerSecondValid) {
    console.error(
      `ASSUMED_MAX_SPEAKING_CHARS_PER_SECOND is misconfigured (${charsPerSecondConfigured}); falling back to the default of 20 for the crisis-audio truncation floor.`
    );
  }
  const charsPerSecond = charsPerSecondValid ? charsPerSecondConfigured : 20;
  if (bytesPerSecond === null) {
    const flatBytesPerCharConfigured = config.minCrisisAudioBytesPerChar;
    const flatBytesPerCharValid =
      Number.isFinite(flatBytesPerCharConfigured) && flatBytesPerCharConfigured > 0;
    if (!flatBytesPerCharValid) {
      console.error(
        `MIN_CRISIS_AUDIO_BYTES_PER_CHAR is misconfigured (${flatBytesPerCharConfigured}); falling back to the default of 300 for the crisis-audio truncation floor.`
      );
    }
    const flatBytesPerChar = flatBytesPerCharValid ? flatBytesPerCharConfigured : 300;
    return Math.ceil(text.length * flatBytesPerChar);
  }
  const dynamicBytesPerChar = bytesPerSecond / charsPerSecond;
  return Math.ceil(text.length * dynamicBytesPerChar);
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Returns the cached crisis audio for this (voice, text, model, format)
 * combination, synthesizing and caching it via `tts` on the first call
 * only. A synthesis failure is never cached, so the next call (crisis or
 * not, same key) retries against the real provider instead of being
 * stuck with a permanently empty cache entry.
 */
export async function getCachedCrisisAudio(
  tts: TtsProvider,
  args: { text: string; voiceId: string; model: string; outputFormat: string }
): Promise<CachedCrisisAudio> {
  const key = cacheKey(args.voiceId, args.text, args.model, args.outputFormat);

  const cached = cache.get(key);
  if (cached) return cached;

  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // Adversarial-review follow-up on finding 3: bound how long a single
    // concurrent/deduplicated synthesis attempt can block every other
    // crisis trigger waiting on it (see the comment on
    // config.crisisAudioTimeoutMs). AbortSignal.timeout fires on its own
    // timer and does not depend on the caller's own request signal.
    const result = await tts.synthesize({
      text: args.text,
      voiceId: args.voiceId,
      model: args.model,
      outputFormat: args.outputFormat,
      signal: AbortSignal.timeout(config.crisisAudioTimeoutMs),
    });
    const bytes = await streamToBytes(result.stream);
    // Finding 5 (third adversarial review): the comment above used to
    // claim "empty or truncated" bodies were rejected, but the check
    // only ever looked at zero length. A stream that ends early but
    // cleanly (truncated mid-sentence, e.g. cut off before the "call
    // 988" line) is nonzero length and used to sail through this check,
    // then get cached and served as the "real" safety audio on every
    // subsequent crisis trigger until the process restarted. The known,
    // fixed safety text (`args.text`) and the actual output format give
    // an expected minimum size (see minExpectedBytes above): a body
    // shorter than that floor is treated as truncated, same as an empty
    // one, and is never written to `cache`, so the next caller (crisis
    // or not, same key) retries the real provider instead of inheriting
    // the bad result.
    const expectedBytes = minExpectedBytes(args.text, args.outputFormat);
    if (bytes.length === 0) {
      throw new Error("crisis audio synthesis returned an empty body");
    }
    if (bytes.length < expectedBytes) {
      throw new Error(
        `crisis audio synthesis returned a truncated body (${bytes.length} bytes for ${args.text.length} characters of text at output format ${args.outputFormat}, expected at least ${expectedBytes})`
      );
    }
    const entry: CachedCrisisAudio = { bytes, contentType: result.contentType };
    cache.set(key, entry);
    return entry;
  })();

  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    // Whether it succeeded (now also in `cache`) or failed, this key is
    // no longer in flight; a failure intentionally leaves nothing in
    // `cache`, so the next caller retries the real provider.
    pending.delete(key);
  }
}

/** Test-only: clears the cache and any in-flight synthesis so tests do not leak state across cases. */
export function resetCrisisAudioCache(): void {
  cache.clear();
  pending.clear();
}

/** Test-only: how many distinct (voice, text, model, format) entries are cached right now. */
export function crisisAudioCacheSize(): number {
  return cache.size;
}
