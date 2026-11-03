import type {
  ChatRequest,
  ChatResult,
  LlmProvider,
  StreamDelta,
} from "../types";
import { ProviderError } from "../types";

export type FakeLlmScript = {
  /** Text returned for a non-streaming chat() call, or streamed sentence by sentence. */
  reply?: string;
  /** If set, chat()/chatStream() throws a ProviderError with this message instead of replying. */
  throwError?: string;
  /** Delay in ms before the first token/reply, to simulate network latency in tests. */
  delayMs?: number;
  /** Delay in ms injected between each streamed delta, for streaming-order tests. */
  deltaDelayMs?: number;
};

const DEFAULT_REPLY = "I hear you. Tell me more about that.";

function sleep(ms: number) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Deterministic, scriptable fake used by every test and by CI. Never makes
 * a network call. Refuses to run in production so a misconfigured deploy
 * cannot silently serve fake replies.
 */
export class FakeLlmProvider implements LlmProvider {
  public calls: ChatRequest[] = [];
  public cancelled = 0;

  constructor(private script: FakeLlmScript = {}) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FakeLlmProvider must never run with NODE_ENV=production");
    }
  }

  setScript(script: FakeLlmScript) {
    this.script = script;
  }

  cancel() {
    this.cancelled += 1;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls.push(req);
    if (this.script.delayMs) await sleep(this.script.delayMs);
    if (this.script.throwError) {
      throw new ProviderError(this.script.throwError, "llm");
    }
    const text = this.script.reply ?? DEFAULT_REPLY;
    return {
      text,
      inputTokens: estimateTokens(req.messages.map((m) => m.content).join(" ")),
      outputTokens: estimateTokens(text),
    };
  }

  async *chatStream(
    req: ChatRequest
  ): AsyncGenerator<StreamDelta, ChatResult, void> {
    this.calls.push(req);
    if (this.script.delayMs) await sleep(this.script.delayMs);
    if (this.script.throwError) {
      throw new ProviderError(this.script.throwError, "llm");
    }
    const text = this.script.reply ?? DEFAULT_REPLY;
    // Stream sentence by sentence so chunker/timing tests have real boundaries.
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
    for (const sentence of sentences) {
      if (this.script.deltaDelayMs) await sleep(this.script.deltaDelayMs);
      yield { type: "text_delta", text: sentence };
    }
    return {
      text,
      inputTokens: estimateTokens(req.messages.map((m) => m.content).join(" ")),
      outputTokens: estimateTokens(text),
    };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
