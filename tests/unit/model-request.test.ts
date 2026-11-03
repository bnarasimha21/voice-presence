import { describe, it, expect } from "vitest";
import { buildMessagesRequest, familyOf } from "@/lib/model-request";

describe("familyOf", () => {
  it("classifies sonnet, haiku, opus and unknown ids", () => {
    expect(familyOf("claude-sonnet-5-5")).toBe("sonnet");
    expect(familyOf("claude-haiku-5-5")).toBe("haiku");
    expect(familyOf("claude-opus-5")).toBe("opus");
    expect(familyOf("some-future-model")).toBe("unknown");
  });
});

describe("buildMessagesRequest", () => {
  const base = {
    model: "claude-sonnet-5-5",
    systemPrompt: "system",
    messages: [{ role: "user" as const, content: "hi" }],
    maxTokens: 256,
  };

  it("never sends thinking:disabled to a sonnet model", () => {
    const req = buildMessagesRequest({ ...base, model: "claude-sonnet-5-5" });
    expect(req).toHaveProperty("thinking");
    if ("thinking" in req) {
      expect(req.thinking.type).not.toBe("disabled");
      expect(req.thinking.type).toBe("between_tools");
    }
  });

  it("disables thinking for a haiku model", () => {
    const req = buildMessagesRequest({ ...base, model: "claude-haiku-5-5" });
    expect("thinking" in req && req.thinking.type).toBe("disabled");
  });

  it("omits the thinking field entirely for an unknown model family", () => {
    const req = buildMessagesRequest({ ...base, model: "some-future-model" });
    expect("thinking" in req).toBe(false);
  });

  it("always carries model, max_tokens, system and messages through", () => {
    const req = buildMessagesRequest(base);
    expect(req.model).toBe(base.model);
    expect(req.max_tokens).toBe(base.maxTokens);
    expect(req.system).toBe(base.systemPrompt);
    expect(req.messages).toEqual(base.messages);
  });
});
