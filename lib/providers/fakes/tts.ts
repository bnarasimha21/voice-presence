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
function fixtureAudioBytes(text: string): Uint8Array {
  const base = new TextEncoder().encode(`FAKE_AUDIO:${text}`);
  // Pad so even very short text produces a plausible audio-sized payload.
  const padded = new Uint8Array(Math.max(base.length, 32));
  padded.set(base);
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
