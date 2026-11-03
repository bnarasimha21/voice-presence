import type { SttProvider, SttRequest, SttResult } from "../types";
import { ProviderError } from "../types";

export type FakeSttScript = {
  transcript?: string;
  throwError?: string;
  delayMs?: number;
  audioSeconds?: number;
};

function sleep(ms: number) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export class FakeSttProvider implements SttProvider {
  public calls: SttRequest[] = [];

  constructor(private script: FakeSttScript = {}) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FakeSttProvider must never run with NODE_ENV=production");
    }
  }

  setScript(script: FakeSttScript) {
    this.script = script;
  }

  async transcribe(req: SttRequest): Promise<SttResult> {
    this.calls.push(req);
    if (this.script.delayMs) await sleep(this.script.delayMs);
    if (this.script.throwError) {
      throw new ProviderError(this.script.throwError, "stt");
    }
    return {
      transcript: this.script.transcript ?? "this is a fixture transcript",
      audioSeconds: this.script.audioSeconds ?? 2,
    };
  }
}
