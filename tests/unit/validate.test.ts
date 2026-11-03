import { describe, it, expect } from "vitest";
import {
  LOOSE_MAX_MESSAGE_CHARS,
  LOOSE_MAX_MESSAGES,
  extractLooseChatFields,
  lookupPersona,
  validateChatBody,
  validateTtsBody,
} from "@/lib/validate";

describe("lookupPersona", () => {
  it("rejects 'constructor' instead of resolving Object.prototype.constructor", () => {
    expect(lookupPersona("constructor")).toBeNull();
  });

  it("rejects '__proto__' and 'toString'", () => {
    expect(lookupPersona("__proto__")).toBeNull();
    expect(lookupPersona("toString")).toBeNull();
  });

  it("rejects non-string ids", () => {
    expect(lookupPersona(123)).toBeNull();
    expect(lookupPersona(undefined)).toBeNull();
    expect(lookupPersona(null)).toBeNull();
  });

  it("resolves a real persona id", () => {
    expect(lookupPersona("abhi")).not.toBeNull();
  });
});

describe("validateChatBody", () => {
  it("rejects a non-object body", () => {
    expect(validateChatBody("nope").ok).toBe(false);
    expect(validateChatBody(null).ok).toBe(false);
  });

  it("rejects missing personaId", () => {
    const result = validateChatBody({ messages: [{ role: "user", content: "hi" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty messages array", () => {
    const result = validateChatBody({ personaId: "abhi", messages: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed message", () => {
    const result = validateChatBody({
      personaId: "abhi",
      messages: [{ role: "system", content: "hi" }],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid body", () => {
    const result = validateChatBody({
      personaId: "abhi",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.ok).toBe(true);
  });
});

// Finding 1 follow-up (fourth adversarial review, second pass): the
// crisis check runs on extractLooseChatFields' output without any size
// cap of its own, which previously let a handful of multi-megabyte
// messages make the crisis check's own regex matching the expensive
// operation. These test the actual bounding behavior directly rather
// than only indirectly through a full route handler.
describe("extractLooseChatFields bounding", () => {
  it("keeps only the last LOOSE_MAX_MESSAGES raw entries", () => {
    const messages = Array.from({ length: LOOSE_MAX_MESSAGES + 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
    }));
    const result = extractLooseChatFields({ personaId: "abhi", messages });
    expect(result.messages).toHaveLength(LOOSE_MAX_MESSAGES);
    // The kept entries are the TAIL of the original array (the most
    // recent messages), not an arbitrary slice.
    expect(result.messages[0].content).toBe(`msg-${50}`);
    expect(result.messages.at(-1)!.content).toBe(`msg-${LOOSE_MAX_MESSAGES + 49}`);
  });

  it("truncates a single message's content to the last LOOSE_MAX_MESSAGE_CHARS characters", () => {
    const padding = "x".repeat(LOOSE_MAX_MESSAGE_CHARS + 1000);
    const content = `${padding}I want to kill myself`;
    const result = extractLooseChatFields({
      personaId: "abhi",
      messages: [{ role: "user", content }],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toHaveLength(LOOSE_MAX_MESSAGE_CHARS);
    // The kept slice is the TAIL of the content, so a phrase near the
    // end of an oversized message survives the truncation.
    expect(result.messages[0].content.endsWith("I want to kill myself")).toBe(true);
  });

  it("drops a phrase that sits outside the kept tail of an oversized message", () => {
    // The known, accepted limitation of tail-only truncation: a crisis
    // phrase buried under more than LOOSE_MAX_MESSAGE_CHARS of trailing
    // padding is not in the scanned window at all. This documents that
    // trade-off with a concrete assertion rather than leaving it
    // implicit, so a future change to the truncation strategy notices if
    // it silently changes this behavior.
    const content = `I want to kill myself${"x".repeat(LOOSE_MAX_MESSAGE_CHARS + 1000)}`;
    const result = extractLooseChatFields({
      personaId: "abhi",
      messages: [{ role: "user", content }],
    });
    expect(result.messages[0].content.includes("I want to kill myself")).toBe(false);
  });

  it("leaves a normal-sized conversation untouched", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
      { role: "user" as const, content: "I want to kill myself" },
    ];
    const result = extractLooseChatFields({ personaId: "abhi", messages });
    expect(result.messages).toEqual(messages);
  });
});

describe("validateTtsBody", () => {
  it("rejects free-form text even alongside a token", () => {
    const result = validateTtsBody({ text: "say this instead", replyToken: "abc.def" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing replyToken", () => {
    expect(validateTtsBody({}).ok).toBe(false);
  });

  it("accepts a replyToken-only body", () => {
    expect(validateTtsBody({ replyToken: "abc.def" }).ok).toBe(true);
  });
});
