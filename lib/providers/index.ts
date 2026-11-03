import { config, isProduction } from "@/lib/config";
import type { LlmProvider, SttProvider, TtsProvider } from "./types";
import { AnthropicLlmProvider } from "./real/llm";
import { DeepgramSttProvider } from "./real/stt";
import { ElevenLabsTtsProvider } from "./real/tts";
import { FakeLlmProvider } from "./fakes/llm";
import { FakeSttProvider } from "./fakes/stt";
import { FakeTtsProvider } from "./fakes/tts";

export type Providers = {
  llm: LlmProvider;
  stt: SttProvider;
  tts: TtsProvider;
};

// Singletons so fakes keep their call history across a request's lifetime
// and so repeated calls do not rebuild vendor clients. Tests that need a
// fresh fake (to reset call counters or scripts) should import the fake
// classes directly instead of this factory.
let singleton: Providers | null = null;

function build(): Providers {
  if (config.providers === "fake") {
    if (isProduction()) {
      throw new Error(
        "VOICE_PROVIDERS=fake is not allowed when NODE_ENV=production"
      );
    }
    return {
      llm: new FakeLlmProvider(),
      stt: new FakeSttProvider(),
      tts: new FakeTtsProvider(),
    };
  }
  return {
    llm: new AnthropicLlmProvider(),
    stt: new DeepgramSttProvider(),
    tts: new ElevenLabsTtsProvider(),
  };
}

export function providers(): Providers {
  if (!singleton) singleton = build();
  return singleton;
}

/** Test-only escape hatch: force a fresh set of providers (e.g. fakes with a script). */
export function resetProviders(next?: Providers) {
  singleton = next ?? null;
}
