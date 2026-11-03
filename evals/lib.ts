// Issue 6: the measuring logic for the voice eval suite, kept separate
// from the CLI entry point (run.ts) so a vitest integration test can
// import and assert on it directly instead of shelling out.
//
// Scope note (stated here and in the final report): this suite measures
// per-stage latency and an approximate cost per turn, through the real
// /api/turn route handler against scripted fake providers. It does not
// measure turn-taking or barge-in timing, because those require a real
// browser (VAD running on a MediaStream, actual audio playback being
// interrupted) that a Node-side eval script cannot exercise. Issue 5's
// turn-state reducer is exhaustively unit tested instead (see
// tests/unit/turn-state.test.ts), which covers the transition logic;
// the browser-side latency of a real barge-in is not covered here.

import { NextRequest } from "next/server";
import { POST as turnHandler } from "@/app/api/turn/route";
import { resetProviders } from "@/lib/providers";
import { FakeLlmProvider } from "@/lib/providers/fakes/llm";
import { FakeSttProvider } from "@/lib/providers/fakes/stt";
import { FakeTtsProvider } from "@/lib/providers/fakes/tts";
import { resetRateLimits, resetSessionTurns, resetDailyUsage } from "@/lib/limits";
import { estimateCostUsd } from "./pricing";
import type { EvalScenario } from "./scenarios";

export type EvalResult = {
  scenarioId: string;
  reply: string;
  timingMs: Record<string, number>;
  firstAudioMs: number | null;
  turnDoneMs: number;
  withinBudget: boolean;
  estimatedCostUsd: number;
  audioEventCount: number;
};

async function readNdjson(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Record<string, unknown>[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

export async function runScenario(scenario: EvalScenario): Promise<EvalResult> {
  resetProviders({
    llm: new FakeLlmProvider({
      reply: scenario.llmReply,
      delayMs: scenario.llmDelayMs,
      deltaDelayMs: scenario.llmDeltaDelayMs,
    }),
    tts: new FakeTtsProvider({ delayMs: scenario.ttsDelayMs }),
    stt: new FakeSttProvider(), // this suite does not exercise STT; present only to satisfy the Providers type
  });
  resetRateLimits();
  resetSessionTurns();
  resetDailyUsage();

  const req = new NextRequest("http://localhost:3000/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      personaId: scenario.personaId,
      messages: [{ role: "user", content: scenario.userMessage }],
    }),
  });

  const res = await turnHandler(req);
  if (res.status !== 200) {
    throw new Error(`scenario ${scenario.id} got non-200 status ${res.status}`);
  }
  const events = await readNdjson(res.body!);
  const done = events.find((e) => e.type === "done");
  if (!done) {
    throw new Error(`scenario ${scenario.id} produced no "done" event`);
  }

  const timing = done.timing as Record<string, number>;
  const audioEventCount = events.filter((e) => e.type === "audio").length;

  // Approximate cost from what this scenario actually produced: output
  // chars spoken (ttsChars) and a rough token estimate for the LLM side,
  // since the fake provider's token estimate is length-based, same as
  // the route's own fallback.
  const reply = String(done.reply ?? "");
  const estimatedCostUsd = estimateCostUsd({
    llmInputTokens: Math.max(1, Math.round(scenario.userMessage.length / 4)),
    llmOutputTokens: Math.max(1, Math.round(reply.length / 4)),
    sttSeconds: 0,
    ttsChars: reply.length,
  });

  return {
    scenarioId: scenario.id,
    reply,
    timingMs: timing,
    firstAudioMs: timing.first_audio_sent ?? null,
    turnDoneMs: timing.turn_done ?? 0,
    withinBudget: (timing.first_audio_sent ?? Infinity) <= scenario.maxFirstAudioMs,
    estimatedCostUsd,
    audioEventCount,
  };
}

export async function runAllScenarios(scenarios: EvalScenario[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  return results;
}
