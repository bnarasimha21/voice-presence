// Issue 6: `npm run eval` entry point. Runs every scripted scenario
// against the fake providers (never real network calls, never a real
// API key) through the actual /api/turn route, and prints a latency and
// cost report. Exits non-zero if any scenario breaches its latency
// budget, so this can be wired into CI as a budget gate later without
// further changes here.

import { scenarios } from "./scenarios";
import { runAllScenarios } from "./lib";

async function main() {
  const results = await runAllScenarios(scenarios);

  console.log("\nVoice eval report\n" + "=".repeat(60));
  let anyOverBudget = false;
  for (const r of results) {
    const status = r.withinBudget ? "OK" : "OVER BUDGET";
    if (!r.withinBudget) anyOverBudget = true;
    console.log(
      `\n[${status}] ${r.scenarioId}\n` +
        `  first audio:   ${r.firstAudioMs ?? "n/a"} ms\n` +
        `  turn done:     ${r.turnDoneMs} ms\n` +
        `  audio chunks:  ${r.audioEventCount}\n` +
        `  est. cost:     $${r.estimatedCostUsd.toFixed(5)}`
    );
  }

  const totalCost = results.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
  console.log("\n" + "=".repeat(60));
  console.log(`Total scenarios: ${results.length}`);
  console.log(`Total estimated cost: $${totalCost.toFixed(5)}`);
  console.log(`Scope note: latency and cost only; turn-taking and barge-in`);
  console.log(`timing are not measured here (see evals/lib.ts header).`);

  if (anyOverBudget) {
    console.error("\nOne or more scenarios exceeded their latency budget.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
