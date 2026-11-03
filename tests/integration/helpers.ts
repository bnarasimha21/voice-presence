// Shared helpers for integration tests that drive the real route handlers
// directly, on the fake providers, with no network and no real keys.

import { resetProviders } from "@/lib/providers";
import { FakeLlmProvider, type FakeLlmScript } from "@/lib/providers/fakes/llm";
import { FakeSttProvider, type FakeSttScript } from "@/lib/providers/fakes/stt";
import { FakeTtsProvider, type FakeTtsScript } from "@/lib/providers/fakes/tts";
import { resetRateLimits, resetSessionTurns, resetDailyUsage } from "@/lib/limits";
import { resetRedeemedTokens } from "@/lib/turn-token";
import { signSessionCookie } from "@/lib/request-context";
import { resetCrisisAudioCache } from "@/lib/crisis-audio-cache";

export type FakeSet = {
  llm: FakeLlmProvider;
  stt: FakeSttProvider;
  tts: FakeTtsProvider;
};

export function installFakes(scripts?: {
  llm?: FakeLlmScript;
  stt?: FakeSttScript;
  tts?: FakeTtsScript;
}): FakeSet {
  const set: FakeSet = {
    llm: new FakeLlmProvider(scripts?.llm),
    stt: new FakeSttProvider(scripts?.stt),
    tts: new FakeTtsProvider(scripts?.tts),
  };
  resetProviders(set);
  resetRateLimits();
  resetSessionTurns();
  resetDailyUsage();
  resetRedeemedTokens();
  resetCrisisAudioCache();
  return set;
}

/**
 * A signed session cookie header for a fixed, caller-chosen session id, so
 * a test can make several requests (e.g. /api/chat then /api/tts) that
 * the server resolves to the same session, matching how a real browser
 * reuses one cookie across a conversation.
 */
export function sessionCookieHeader(sessionId: string): string {
  return `vp_session=${signSessionCookie(sessionId)}`;
}

export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
