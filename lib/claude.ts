import Anthropic from "@anthropic-ai/sdk";
import type { Persona } from "./personas";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export async function chat(
  persona: Persona,
  messages: Message[]
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256, // Keep responses short — this is voice
    system: persona.systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}
