// Issue 5: the turn-taking state machine, as a pure reducer. No DOM, no
// audio, no network: this is the part that can be exhaustively tested and
// reasoned about, separately from the browser wiring (VAD, AudioContext,
// MediaRecorder) that drives it. The browser wiring is listed as not yet
// built in the project report; this reducer is the real, usable piece of
// issue 5 that is complete and tested end to end.

export type TurnState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

export type TurnEvent =
  | { type: "VOICE_DETECTED" } // VAD: user started talking
  | { type: "VOICE_ENDED" } // VAD: user stopped talking (utterance complete)
  | { type: "SUBMITTED" } // transcript sent to the server, waiting on a reply
  | { type: "REPLY_STARTED" } // first audio chunk for the reply is ready to play
  | { type: "REPLY_FINISHED" } // all reply audio has finished playing
  | { type: "BARGE_IN" } // user started talking while the assistant was speaking
  | { type: "CANCELLED" } // request aborted (barge-in cleanup, or explicit stop)
  | { type: "RESET" }; // return to idle regardless of current state

export type TurnTransition = {
  from: TurnState;
  event: TurnEvent["type"];
  to: TurnState;
};

// The full transition table, spelled out so a test can enumerate every
// (state, event) pair and assert there is no silent no-op for a case that
// should actually move the state. Unlisted (state, event) pairs are a
// deliberate no-op: the event is ignored and the state does not change.
const TABLE: TurnTransition[] = [
  { from: "idle", event: "VOICE_DETECTED", to: "listening" },
  { from: "listening", event: "VOICE_ENDED", to: "thinking" },
  { from: "listening", event: "SUBMITTED", to: "thinking" },
  { from: "thinking", event: "REPLY_STARTED", to: "speaking" },
  { from: "thinking", event: "CANCELLED", to: "idle" },
  { from: "speaking", event: "REPLY_FINISHED", to: "idle" },
  { from: "speaking", event: "BARGE_IN", to: "interrupted" },
  { from: "interrupted", event: "CANCELLED", to: "listening" },
  { from: "interrupted", event: "VOICE_ENDED", to: "thinking" },
];

export function reduceTurnState(state: TurnState, event: TurnEvent): TurnState {
  if (event.type === "RESET") return "idle";
  const match = TABLE.find((t) => t.from === state && t.event === event.type);
  return match ? match.to : state;
}

export const turnTransitionTable = TABLE;
