// Provider seams: every paid service (LLM, STT, TTS) is called only through
// these interfaces, so routes and tests can swap in fakes without touching
// vendor SDKs or network code.

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  maxTokens: number;
};

export type ChatResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

export type StreamDelta = {
  type: "text_delta";
  text: string;
};

export interface LlmProvider {
  /** Non-streaming reply (used by /api/chat today, kept for issue 1-3 routes). */
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Streaming reply, used by /api/turn (issue 4). Yields text deltas. */
  chatStream(req: ChatRequest): AsyncGenerator<StreamDelta, ChatResult, void>;
}

export type SttRequest = {
  audio: Blob;
  model: string;
};

export type SttResult = {
  transcript: string;
  audioSeconds: number;
};

export interface SttProvider {
  transcribe(req: SttRequest): Promise<SttResult>;
}

export type TtsRequest = {
  text: string;
  voiceId: string;
  model: string;
  outputFormat: string;
};

export type TtsResult = {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
};

export interface TtsProvider {
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: "llm" | "stt" | "tts"
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
