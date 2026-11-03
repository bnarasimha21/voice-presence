import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  ChatResult,
  LlmProvider,
  StreamDelta,
} from "../types";
import { ProviderError } from "../types";
import { buildMessagesRequest } from "@/lib/model-request";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ProviderError("ANTHROPIC_API_KEY not set", "llm");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export class AnthropicLlmProvider implements LlmProvider {
  async chat(req: ChatRequest): Promise<ChatResult> {
    try {
      const response = await getClient().messages.create(
        buildMessagesRequest(req)
      );
      const block = response.content[0];
      if (block.type !== "text") {
        throw new ProviderError("Unexpected response type from Claude", "llm");
      }
      return {
        text: block.text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Claude request failed: ${err instanceof Error ? err.message : String(err)}`,
        "llm"
      );
    }
  }

  async *chatStream(
    req: ChatRequest
  ): AsyncGenerator<StreamDelta, ChatResult, void> {
    try {
      const stream = getClient().messages.stream(buildMessagesRequest(req));
      let text = "";
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          text += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      return {
        text,
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Claude stream failed: ${err instanceof Error ? err.message : String(err)}`,
        "llm"
      );
    }
  }
}
