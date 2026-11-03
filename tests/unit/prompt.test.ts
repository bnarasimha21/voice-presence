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
