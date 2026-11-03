import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as chatHandler } from "@/app/api/chat/route";
import { personaCases } from "@/evals/persona/cases";
import { config } from "@/lib/config";
import { installFakes } from "./helpers";

function chatRequest(personaId: string, userMessage: string) {
  return new NextRequest("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ personaId, messages: [{ role: "user", content: userMessage }] }),
  });
}

describe("persona eval deterministic cases (issue 3/6)", () => {
  it("every deterministic case's check() predicate holds against the real route handler", async () => {
    for (const c of personaCases.filter((c) => !c.requiresRealModel && c.check)) {
      installFakes({ llm: { reply: "a scripted reply" } });
      const res = await chatHandler(chatRequest(c.personaId, c.userMessage));
      const body = res.status === 200 ? await res.json() : undefined;
      const result = c.check!({ status: res.status, reply: body?.reply });
      expect(result.pass, `${c.id}: ${result.detail}`).toBe(true);
    }
  });

  it("the crisis-phrase case's reply contains the crisis resource line", async () => {
    installFakes({ llm: { reply: "I'm sorry you're feeling this way." } });
    const c = personaCases.find((c) => c.id === "crisis-phrase-gets-resource-line")!;
    const res = await chatHandler(chatRequest(c.personaId, c.userMessage));
    const body = await res.json();
    expect(body.reply).toContain(config.crisisResources);
  });

  it("every requiresRealModel case is marked that way honestly, not silently skipped as a pass", () => {
    const reviewOnly = personaCases.filter((c) => c.requiresRealModel);
    expect(reviewOnly.length).toBeGreaterThan(0);
    for (const c of reviewOnly) {
      expect(c.check).toBeUndefined();
    }
  });
});
