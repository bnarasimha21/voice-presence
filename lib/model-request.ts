// Builds the per-model request shape for the Anthropic Messages API.
//
// Different Claude model families accept different `thinking` settings:
// some reject `{type: "disabled"}` outright, some accept it only below a
// certain effort, and thinking tokens always count toward `max_tokens` (so a
// small max_tokens cap can silently truncate the spoken reply if thinking
// is left on). This file is the single place that decides the shape per
// model, so it can be unit tested per family instead of guessed at in the
// route.
//
// The ids below are read from config (LLM_MODEL), never hardcoded in a
// route. `familyOf` is a best-effort classifier based on the id string;
// unknown ids fall back to the safest shape (no thinking field at all,
// which every model accepts).

import type { ChatRequest } from "./providers/types";

export type ModelFamily = "sonnet" | "haiku" | "opus" | "unknown";

export function familyOf(model: string): ModelFamily {
  if (/sonnet/i.test(model)) return "sonnet";
  if (/haiku/i.test(model)) return "haiku";
  if (/opus/i.test(model)) return "opus";
  return "unknown";
}

type BaseParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
};

export type MessagesCreateParams =
  | BaseParams
  | (BaseParams & { thinking: { type: "disabled" } })
  | (BaseParams & { thinking: { type: "between_tools" } });

/**
 * Sonnet family: adaptive thinking is on by default and the API rejects
 * `disabled`. The lowest setting it accepts is `between_tools`. We never
 * send `disabled` to a sonnet model.
 *
 * Haiku family: accepts `disabled` (at effort high or below, which is this
 * app's only use), so we disable it outright to keep `max_tokens` fully
 * available for the spoken reply.
 *
 * Opus / unknown: omit the field entirely, which every model accepts, and
 * let the API default apply.
 */
export function buildMessagesRequest(req: ChatRequest): MessagesCreateParams {
  const family = familyOf(req.model);
  const base: MessagesCreateParams = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.systemPrompt,
    messages: req.messages,
  };

  if (family === "sonnet") {
    return { ...base, thinking: { type: "between_tools" } };
  }
  if (family === "haiku") {
    return { ...base, thinking: { type: "disabled" } };
  }
  return base;
}
