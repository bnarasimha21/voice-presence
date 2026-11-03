// Issue 5/12: the turn-taking state machine, as a pure reducer. No DOM, no
// audio, no network: this is the part that can be exhaustively tested and
// reasoned about, separately from the browser wiring (VAD, AudioContext,
// MediaRecorder) that drives it. The browser wiring is listed as not yet
// built in the project report; this reducer is the real, usable piece of
// issue 5 that is complete and tested end to end.

export type TurnState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

// Issue 12: every event that belongs to a specific server turn (the
// request/reply round trip started by SUBMITTED) carries that turn's id.
// A reply event whose id does not match the id of the turn the machine is
// currently tracking is a stale/late event -- e.g. the first reply's
// REPLY_STARTED arriving after the user has already barged in and started
// a second turn -- and must be ignored rather than resurrecting stale
// audio into a fresh turn.
export type TurnEvent =
  | { type: "VOICE_DETECTED" } // VAD: user started talking
  | { type: "VOICE_ENDED" } // VAD: user stopped talking (utterance complete)
  | { type: "SUBMITTED"; turnId: number } // transcript sent to the server, waiting on a reply
  | { type: "REPLY_STARTED"; turnId: number } // first audio chunk for the reply is ready to play
  | { type: "REPLY_FINISHED"; turnId: number } // all reply audio has finished playing (or there was none to play)
  | { type: "CANCELLED" } // request aborted (barge-in cleanup, or explicit stop)
  | { type: "RESET" }; // return to idle regardless of current state

export type TurnMachineState = {
  state: TurnState;
  // The id of the turn currently being tracked (set by SUBMITTED), or
  // null when there is no in-flight server turn. Used to reject stale
  // REPLY_STARTED/REPLY_FINISHED events that belong to a superseded turn.
  turnId: number | null;
};

export const initialTurnState: TurnMachineState = { state: "idle", turnId: null };

export function reduceTurnState(current: TurnMachineState, event: TurnEvent): TurnMachineState {
  const { state, turnId } = current;

  if (event.type === "RESET") {
    return { state: "idle", turnId: null };
  }

  if (event.type === "CANCELLED") {
    // Issue 12: previously CANCELLED only had listed transitions from
    // "thinking" and "interrupted", so cancelling while "speaking" (e.g.
    // the user presses a stop button mid-reply) was a silent no-op and
    // the turn stayed stuck in "speaking" forever, with no way back to
    // idle short of RESET. Valid from every non-idle state now: both
    // "thinking" and "speaking" drop the in-flight turn and return to
    // idle; "interrupted" returns to "listening" so the mic stays live
    // for the utterance that caused the interruption. "idle" and
    // "listening" (nothing has been submitted yet) stay deliberate no-ops.
    if (state === "thinking" || state === "speaking") {
      return { state: "idle", turnId: null };
    }
    if (state === "interrupted") {
      return { state: "listening", turnId: null };
    }
    return current;
  }

  if (event.type === "VOICE_DETECTED") {
    if (state === "idle") {
      return { state: "listening", turnId };
    }
    // Issue 12: a new utterance must interrupt a turn that is still being
    // worked on, not just one that has started speaking. The previous
    // table only listed "speaking" + a separate BARGE_IN event; "thinking"
    // had no transition at all, so talking again while the assistant was
    // still waiting on the LLM/TTS did nothing, and the stale reply still
    // played once it eventually arrived. Both now interrupt consistently,
    // which also makes the separate BARGE_IN event redundant: VOICE_DETECTED
    // is the real signal the browser's VAD emits either way.
    if (state === "thinking" || state === "speaking") {
      return { state: "interrupted", turnId };
    }
    return current;
  }

  if (event.type === "VOICE_ENDED") {
    if (state === "listening" || state === "interrupted") {
      return { state: "thinking", turnId };
    }
    return current;
  }

  if (event.type === "SUBMITTED") {
    // Valid directly from "listening" (the common case), and also from
    // "thinking" for a flow where VOICE_ENDED already moved the machine
    // to "thinking" before the async submit call resolves with the
    // server-assigned turn id.
    if (state === "listening" || state === "thinking") {
      return { state: "thinking", turnId: event.turnId };
    }
    return current;
  }

  if (event.type === "REPLY_STARTED") {
    // Issue 12: ignore a REPLY_STARTED that does not belong to the turn
    // currently being tracked. Without this check, the first reply's
    // REPLY_STARTED arriving late (after a barge-in cancelled it and
    // started a second turn) would match the bare "thinking" -> "speaking"
    // transition and start playing stale, superseded audio.
    if (state === "thinking" && event.turnId === turnId) {
      return { state: "speaking", turnId };
    }
    return current;
  }

  if (event.type === "REPLY_FINISHED") {
    if (event.turnId !== turnId) return current;
    // Issue 12: previously only listed from "speaking". A reply that
    // produces no audio at all (e.g. an empty LLM reply, or a TTS call
    // that fails after the text has already been delivered) never fires
    // REPLY_STARTED, so the machine would be stuck in "thinking" forever
    // once nothing ever "finishes" playing. Accepting REPLY_FINISHED from
    // "thinking" too lets that case return to idle.
    if (state === "thinking" || state === "speaking") {
      return { state: "idle", turnId: null };
    }
    return current;
  }

  return current;
}
