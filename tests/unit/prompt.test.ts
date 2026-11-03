import { describe, it, expect } from "vitest";
import { matchesCrisisPhrase, applyCrisisBackstop } from "@/lib/personas/prompt";
import { config } from "@/lib/config";

describe("matchesCrisisPhrase", () => {
  it("matches an explicit crisis phrase", () => {
    expect(matchesCrisisPhrase("I want to kill myself")).toBe(true);
  });

  it("does not match ordinary chat", () => {
    expect(matchesCrisisPhrase("I had a rough day at work")).toBe(false);
  });

  // Issue 1 regression (adversarial review): /\bsuicidal?\b/ matches
  // "suicidal" but can never match the plain noun "suicide", since it
  // only allows an optional trailing "l" after "suicida". These cases
  // reproduce the miss directly, without requiring "commit"/"committing"
  // immediately before the word.
  it("matches the plain noun 'suicide' with no 'commit' verb nearby", () => {
    expect(matchesCrisisPhrase("thinking about suicide")).toBe(true);
    expect(matchesCrisisPhrase("my suicide plan is ready")).toBe(true);
    expect(matchesCrisisPhrase("I want to attempt suicide tonight")).toBe(true);
  });

  it("still matches 'suicidal'", () => {
    expect(matchesCrisisPhrase("I am suicidal")).toBe(true);
  });
});

describe("applyCrisisBackstop", () => {
  it("appends the resources line when the user message matched and the reply lacks it", () => {
    const reply = applyCrisisBackstop("I want to end my life", "I'm here with you.");
    expect(reply).toContain(config.crisisResources);
  });

  it("does not duplicate the resources line if the reply already has it", () => {
    const already = `I'm here with you. ${config.crisisResources}`;
    const reply = applyCrisisBackstop("I want to end my life", already);
    expect(reply).toBe(already);
  });

  it("leaves an ordinary reply untouched", () => {
    const reply = applyCrisisBackstop("tell me a fun fact", "Sure, here's one.");
    expect(reply).toBe("Sure, here's one.");
  });
});
