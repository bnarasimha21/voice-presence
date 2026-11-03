import { describe, it, expect } from "vitest";
import { lookupPersona, validateChatBody, validateTtsBody } from "@/lib/validate";

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
