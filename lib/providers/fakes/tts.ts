import type { TtsProvider, TtsRequest, TtsResult } from "../types";
import { ProviderError } from "../types";

export type FakeTtsScript = {
  throwError?: string;
  delayMs?: number;
  /** Extra delay before the final chunk, for "starts playback before full response" tests. */
  lastChunkDelayMs?: number;
  /** Number of chunks the fake audio body is split into. */
  chunkCount?: number;
};

function sleep(ms: number) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// Deterministic non-empty "audio" bytes derived from the text, so tests can
// assert non-empty output without decoding real MP3/PCM.
//
// Finding 5 follow-up (third and fourth adversarial reviews): the
// crisis-audio truncation check in lib/crisis-audio-cache.ts rejects a
// synthesis result that is short relative to the input text's length and
// the actual output format's bitrate (see minExpectedBytes there). The
// old fixture produced roughly one byte per character (the marker prefix
// plus the text itself), which a real encoded-speech provider never does
// (real audio runs well over 1000 bytes per character at common voice
// bitrates); against a realistic floor, this fixture's own crisis-path
// tests would wrongly look truncated. The app's real crisis-audio call
// site passes config.ttsOutputFormat (default "mp3_44100_128"), which
// the dynamic floor resolves to 800 bytes/char at the default
// assumedMaxSpeakingCharsPerSecond (20, tightened from 25 -- see
// lib/config.ts finding 1, fourth adversarial review, fourth pass); this
// fixture's multiplier stays comfortably above that new, tighter floor
// so the fake provider's own crisis-path tests never trip the check
// meant for a genuinely truncated real stream.
const FIXTURE_BYTES_PER_CHAR = 1400;

function fixtureAudioBytes(text: string): Uint8Array {
  const base = new TextEncoder().encode(`FAKE_AUDIO:${text}`);
  const target = Math.max(32, text.length * FIXTURE_BYTES_PER_CHAR);
  const padded = new Uint8Array(target);
  for (let i = 0; i < target; i++) {
    padded[i] = base[i % base.length];
  }
  return padded;
}

export class FakeTtsProvider implements TtsProvider {
  public calls: TtsRequest[] = [];
  public cancelled = 0;

  constructor(private script: FakeTtsScript = {}) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FakeTtsProvider must never run with NODE_ENV=production");
    }
  }

  setScript(script: FakeTtsScript) {
    this.script = script;
  }

  cancel() {
    this.cancelled += 1;
  }

  async synthesize(req: TtsRequest): Promise<TtsResult> {
    this.calls.push(req);
    if (this.script.delayMs) await sleep(this.script.delayMs);
    if (this.script.throwError) {
      throw new ProviderError(this.script.throwError, "tts");
    }

    const bytes = fixtureAudioBytes(req.text);
    const chunkCount = Math.max(1, this.script.chunkCount ?? 3);
    const chunkSize = Math.ceil(bytes.length / chunkCount);
    const lastChunkDelayMs = this.script.lastChunkDelayMs ?? 0;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < chunkCount; i++) {
          const chunk = bytes.slice(i * chunkSize, (i + 1) * chunkSize);
          if (chunk.length === 0) continue;
          if (i === chunkCount - 1 && lastChunkDelayMs) {
            await sleep(lastChunkDelayMs);
          }
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    return { stream, contentType: "audio/mpeg" };
  }
}
