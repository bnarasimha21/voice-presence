import { describe, it, expect } from "vitest";
import {
  reduceTurnState,
  turnTransitionTable,
  type TurnState,
  type TurnEvent,
} from "@/lib/turn-state";

const ALL_STATES: TurnState[] = ["idle", "listening", "thinking", "speaking", "interrupted"];
const ALL_EVENT_TYPES: TurnEvent["type"][] = [
  "VOICE_DETECTED",
  "VOICE_ENDED",
  "SUBMITTED",
  "REPLY_STARTED",
  "REPLY_FINISHED",
  "BARGE_IN",
  "CANCELLED",
  "RESET",
];

describe("turn state reducer (issue 5)", () => {
  it("applies every listed transition in the table", () => {
    for (const t of turnTransitionTable) {
      expect(reduceTurnState(t.from, { type: t.event } as TurnEvent)).toBe(t.to);
    }
  });

  it("RESET always returns to idle, from every state", () => {
    for (const s of ALL_STATES) {
      expect(reduceTurnState(s, { type: "RESET" })).toBe("idle");
    }
  });

  it("an event with no listed transition for the current state is a no-op", () => {
    // idle has no entry for REPLY_FINISHED: must stay idle, not throw or jump.
    expect(reduceTurnState("idle", { type: "REPLY_FINISHED" })).toBe("idle");
    // listening has no entry for BARGE_IN (nothing is speaking yet to interrupt).
    expect(reduceTurnState("listening", { type: "BARGE_IN" })).toBe("listening");
  });

  it("every (state, event) pair either moves or is a deliberate no-op, never throws", () => {
    for (const s of ALL_STATES) {
      for (const eventType of ALL_EVENT_TYPES) {
        expect(() => reduceTurnState(s, { type: eventType } as TurnEvent)).not.toThrow();
      }
    }
  });

  it("a full happy-path turn: idle -> listening -> thinking -> speaking -> idle", () => {
    let state: TurnState = "idle";
    state = reduceTurnState(state, { type: "VOICE_DETECTED" });
    expect(state).toBe("listening");
    state = reduceTurnState(state, { type: "VOICE_ENDED" });
    expect(state).toBe("thinking");
    state = reduceTurnState(state, { type: "REPLY_STARTED" });
    expect(state).toBe("speaking");
    state = reduceTurnState(state, { type: "REPLY_FINISHED" });
    expect(state).toBe("idle");
  });

  it("barge-in while speaking interrupts, and a new utterance moves straight to thinking", () => {
    let state: TurnState = "speaking";
    state = reduceTurnState(state, { type: "BARGE_IN" });
    expect(state).toBe("interrupted");
    state = reduceTurnState(state, { type: "VOICE_ENDED" });
    expect(state).toBe("thinking");
  });

  it("cancelling while interrupted returns to listening, not idle, so the mic stays live", () => {
    const state = reduceTurnState("interrupted", { type: "CANCELLED" });
    expect(state).toBe("listening");
  });

  it("cancelling while thinking (e.g. an aborted request) returns to idle", () => {
    const state = reduceTurnState("thinking", { type: "CANCELLED" });
    expect(state).toBe("idle");
  });
});
