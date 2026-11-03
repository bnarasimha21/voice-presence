// Issue 4: per-stage latency marks for one turn. Pure, in-memory, no I/O;
// the route records marks and returns them in the final event and a
// Server-Timing header, and logs them (counts and durations only, never
// transcript or reply text).

export type TimingMarkName =
  | "turn_start"
  | "stt_done"
  | "llm_first_token"
  | "first_sentence"
  | "tts_first_byte"
  | "first_audio_sent"
  | "turn_done";

export class TurnTiming {
  private marks: Partial<Record<TimingMarkName, number>> = {};
  private readonly start: number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.start = now();
    this.marks.turn_start = this.start;
  }

  private now: () => number;

  mark(name: TimingMarkName) {
    if (this.marks[name] === undefined) {
      this.marks[name] = this.now();
    }
  }

  /** Milliseconds since turn_start for each recorded mark. */
  toObject(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.marks)) {
      out[key] = value - this.start;
    }
    return out;
  }

  toServerTimingHeader(): string {
    return Object.entries(this.toObject())
      .map(([name, ms]) => `${name};dur=${Math.max(0, Math.round(ms))}`)
      .join(", ");
  }
}
