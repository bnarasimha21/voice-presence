import { describe, it, expect } from "vitest";
import {
  reduceTurnState,
  initialTurnState,
  type TurnMachineState,
  type TurnState,
} from "@/lib/turn-state";

const ALL_STATES: TurnState[] = ["idle", "listening", "thinking", "speaking", "interrupted"];

function at(state: TurnState, turnId: number | null = null): TurnMachineState {
  return { state, turnId };
}

describe("turn state reducer (issue 5/12)", () => {
  it("RESET always returns to idle with no tracked turn, from every state", () => {
    for (const s of ALL_STATES) {
      expect(reduceTurnState(at(s, 7), { type: "RESET" })).toEqual({ state: "idle", turnId: null });
    }
  });

  it("every (state, event) pair either moves or is a deliberate no-op, never throws", () => {
    const eventTypes = [
      "VOICE_DETECTED",
      "VOICE_ENDED",
      "SUBMITTED",
      "REPLY_STARTED",
      "REPLY_FINISHED",
      "CANCELLED",
      "RESET",
    ] as const;
    for (const s of ALL_STATES) {
      for (const type of eventTypes) {
        const event = type === "SUBMITTED" || type === "REPLY_STARTED" || type === "REPLY_FINISHED"
          ? { type, turnId: 1 }
          : { type };
        expect(() => reduceTurnState(at(s, 1), event as never)).not.toThrow();
      }
    }
  });

  it("a full happy-path turn: idle -> listening -> thinking -> speaking -> idle", () => {
    let m: TurnMachineState = initialTurnState;
    m = reduceTurnState(m, { type: "VOICE_DETECTED" });
    expect(m.state).toBe("listening");
    m = reduceTurnState(m, { type: "VOICE_ENDED" });
    expect(m.state).toBe("thinking");
    m = reduceTurnState(m, { type: "SUBMITTED", turnId: 1 });
    expect(m).toEqual({ state: "thinking", turnId: 1 });
    m = reduceTurnState(m, { type: "REPLY_STARTED", turnId: 1 });
    expect(m).toEqual({ state: "speaking", turnId: 1 });
    m = reduceTurnState(m, { type: "REPLY_FINISHED", turnId: 1 });
    expect(m).toEqual({ state: "idle", turnId: null });
  });

  // Issue 12, regression 1: a stale REPLY_STARTED for a turn that has
  // since been superseded (barge-in started turn 2 while turn 1 was
  // still "thinking") must not resurrect turn 1's audio into turn 2.
  it("a stale REPLY_STARTED for a superseded turn is ignored", () => {
    let m = at("thinking", 1);
    m = reduceTurnState(m, { type: "VOICE_DETECTED" }); // barge-in: turn 1 interrupted
    expect(m.state).toBe("interrupted");
    m = reduceTurnState(m, { type: "VOICE_ENDED" }); // listening again, then a new utterance
    expect(m.state).toBe("thinking");
    m = reduceTurnState(m, { type: "SUBMITTED", turnId: 2 }); // turn 2 starts
    expect(m).toEqual({ state: "thinking", turnId: 2 });

    // Turn 1's reply arrives late.
    const after = reduceTurnState(m, { type: "REPLY_STARTED", turnId: 1 });
    expect(after).toEqual({ state: "thinking", turnId: 2 }); // unchanged, not "speaking"
  });

  // Issue 12, regression 2: CANCELLED while "speaking" used to have no
  // listed transition and left the machine stuck playing a reply forever
  // once a stop button was pressed.
  it("CANCELLED while speaking returns to idle, not stuck", () => {
    const m = reduceTurnState(at("speaking", 1), { type: "CANCELLED" });
    expect(m).toEqual({ state: "idle", turnId: null });
  });

  // Issue 12, regression 3: VOICE_DETECTED while "thinking" (the user
  // starts talking again before the first audio chunk is even ready) used
  // to be a silent no-op, so the stale reply still played once it arrived.
  it("VOICE_DETECTED while thinking interrupts, same as while speaking", () => {
    const m = reduceTurnState(at("thinking", 1), { type: "VOICE_DETECTED" });
    expect(m).toEqual({ state: "interrupted", turnId: 1 });
  });

  it("VOICE_DETECTED while speaking interrupts", () => {
    const m = reduceTurnState(at("speaking", 1), { type: "VOICE_DETECTED" });
    expect(m).toEqual({ state: "interrupted", turnId: 1 });
  });

  // Issue 12, regression 4: a reply with no audio at all (empty LLM
  // reply, or TTS failing after text delivery) never fires REPLY_STARTED.
  // REPLY_FINISHED must still be accepted from "thinking" so the machine
  // does not stay stuck there forever.
  it("REPLY_FINISHED from thinking (no audio ever started) returns to idle", () => {
    const m = reduceTurnState(at("thinking", 1), { type: "REPLY_FINISHED", turnId: 1 });
    expect(m).toEqual({ state: "idle", turnId: null });
  });

  // Issue 12, regression 5: a stale REPLY_FINISHED for an old, superseded
  // turn must not force the new turn out of "thinking" early.
  it("a stale REPLY_FINISHED for a superseded turn is ignored", () => {
    const m = reduceTurnState(at("thinking", 2), { type: "REPLY_FINISHED", turnId: 1 });
    expect(m).toEqual({ state: "thinking", turnId: 2 });
  });

  // Issue 12, regression 6: cancelling while "listening" (nothing has
  // been submitted yet) stays a deliberate no-op; there is no in-flight
  // turn to cancel.
  it("CANCELLED while listening is a no-op", () => {
    const m = reduceTurnState(at("listening", null), { type: "CANCELLED" });
    expect(m).toEqual({ state: "listening", turnId: null });
  });

  it("cancelling while interrupted returns to listening, not idle, so the mic stays live", () => {
    const m = reduceTurnState(at("interrupted", 1), { type: "CANCELLED" });
    expect(m).toEqual({ state: "listening", turnId: null });
  });

  it("REPLY_STARTED for the current turn transitions to speaking", () => {
    const m = reduceTurnState(at("thinking", 1), { type: "REPLY_STARTED", turnId: 1 });
    expect(m).toEqual({ state: "speaking", turnId: 1 });
  });
});
