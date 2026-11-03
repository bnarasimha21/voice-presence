// `npm run eval:persona`. Runs the deterministic cases for real against
// /api/chat with the fake LLM (safe for CI, no network); any case marked
// requiresRealModel is only exercised when VOICE_PROVIDERS=real and a
// real ANTHROPIC_API_KEY is set, and is otherwise reported as skipped,
// never silently passed.

import { NextRequest } from "next/server";
import { POST as chatHandler } from "@/app/api/chat/route";
import { config } from "@/lib/config";
import { personaCases } from "./cases";

function chatRequest(personaId: string, userMessage: string) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId, messages: [{ role: "user", content: userMessage }] }),
  });
}

async function main() {
  const realModelAvailable = config.providers === "real" && !!process.env.ANTHROPIC_API_KEY;

  console.log("\nPersona eval report\n" + "=".repeat(60));
  let failures = 0;
  let skipped = 0;

  for (const c of personaCases) {
    if (c.requiresRealModel && !realModelAvailable) {
      skipped += 1;
      console.log(`\n[SKIPPED] ${c.id} (needs VOICE_PROVIDERS=real + ANTHROPIC_API_KEY)\n  ${c.description}`);
      continue;
    }

    const res = await chatHandler(chatRequest(c.personaId, c.userMessage));
    const status = res.status;
    const body = status === 200 ? await res.json() : undefined;
    const reply: string | undefined = body?.reply;

    if (c.requiresRealModel) {
      // Judged by a human from the printed reply; this script does not
      // attempt to auto-grade persona tone or compliance.
      console.log(`\n[REVIEW] ${c.id}\n  ${c.description}\n  reply: ${reply}`);
      continue;
    }

    if (c.id === "crisis-phrase-gets-resource-line") {
      const pass = status === 200 && !!reply && reply.includes(config.crisisResources);
      if (!pass) failures += 1;
      console.log(`[${pass ? "PASS" : "FAIL"}] ${c.id}`);
      continue;
    }

    if (c.check) {
      const result = c.check({ status, reply });
      if (!result.pass) failures += 1;
      console.log(`[${result.pass ? "PASS" : "FAIL"}] ${c.id} - ${result.detail}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Deterministic cases: ${personaCases.filter((c) => !c.requiresRealModel).length}`);
  console.log(`Skipped (need a real model): ${skipped}`);
  console.log(`Failures: ${failures}`);

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
