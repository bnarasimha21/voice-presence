import { describe, it, expect, afterEach } from "vitest";
import { scenarios } from "@/evals/scenarios";
import { runScenario } from "@/evals/lib";
import { resetProviders } from "@/lib/providers";

// Issue 6 acceptance: the eval harness itself runs for real, against the
// fake providers, through the actual /api/turn route. Not a shell-out to
// the CLI script: this imports the same measuring logic `npm run eval`
// uses, so a broken harness fails the normal test suite too.

describe("voice eval harness (issue 6)", () => {
  afterEach(() => {
    resetProviders();
  });

  it("produces a latency and cost result for every scripted scenario", async () => {
    for (const scenario of scenarios) {
      const result = await runScenario(scenario);
      expect(result.scenarioId).toBe(scenario.id);
      expect(result.reply.length).toBeGreaterThan(0);
      expect(result.audioEventCount).toBeGreaterThan(0);
      expect(result.turnDoneMs).toBeGreaterThan(0);
      expect(result.firstAudioMs).not.toBeNull();
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    }
  });

  it("the crisis-phrase scenario's reply still contains the crisis resource line", async () => {
    const scenario = scenarios.find((s) => s.id === "crisis-phrase")!;
    const result = await runScenario(scenario);
    // lib/personas/prompt.ts's deterministic backstop; this is what
    // actually guarantees the resource line, independent of the model.
    const { config } = await import("@/lib/config");
    expect(result.reply).toContain(config.crisisResources);
  });

  it("the deliberately slow scenario reports a first-audio time consistent with its injected delay", async () => {
    const scenario = scenarios.find((s) => s.id === "slow-model")!;
    const result = await runScenario(scenario);
    expect(result.firstAudioMs).toBeGreaterThanOrEqual(scenario.llmDelayMs);
  });

  it("flags withinBudget=false when a scenario is given an unreachable budget", async () => {
    const scenario = { ...scenarios[0], maxFirstAudioMs: 0 };
    const result = await runScenario(scenario);
    expect(result.withinBudget).toBe(false);
  });
});
