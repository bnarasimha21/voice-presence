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
    // Adversarial-review follow-up on finding 3: a provider that returns
    // a 200 with an empty or truncated body must not be cached as if it
    // were a real success, since every subsequent crisis trigger would
    // then be served silence forever (until the process restarts).
    // Treating it as a failure here means it is never written to
    // `cache`, so the next caller (crisis or not, same key) retries the
    // real provider instead of inheriting the bad result.
    if (bytes.length === 0) {
      throw new Error("crisis audio synthesis returned an empty body");
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
