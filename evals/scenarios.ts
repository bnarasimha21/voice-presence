// Issue 6: scripted scenarios for the voice eval suite. Plain TS objects
// rather than a YAML file: this app has no YAML parser dependency
// anywhere else, and a small fixed list like this does not earn adding
// one. Each scenario drives /api/turn through the fake LLM/TTS providers
// (never real network calls), with a scripted reply and an optional
// artificial delay to approximate a real turn's latency shape.

export type EvalScenario = {
  id: string;
  description: string;
  personaId: string;
  userMessage: string;
  llmReply: string;
  /** Simulated time-to-first-token, ms. */
  llmDelayMs: number;
  /** Simulated per-sentence streaming delay, ms. */
  llmDeltaDelayMs: number;
  /** Simulated TTS latency per sentence, ms. */
  ttsDelayMs: number;
  /** A budget this scenario is checked against; a run fails it if exceeded. */
  maxFirstAudioMs: number;
};

export const scenarios: EvalScenario[] = [
  {
    id: "short-reply",
    description: "A short, single-sentence reply: the common case.",
    personaId: "abhi",
    userMessage: "Hey, how's it going?",
    llmReply: "I'm doing okay, thanks for asking.",
    llmDelayMs: 150,
    llmDeltaDelayMs: 0,
    ttsDelayMs: 120,
    maxFirstAudioMs: 1500,
  },
  {
    id: "multi-sentence-reply",
    description: "A longer reply with several sentences, to check that the first sentence is spoken well before the last one finishes generating.",
    personaId: "abhi",
    userMessage: "I've had a rough week and I don't really know where to start.",
    llmReply:
      "That sounds like a lot to carry. I'm glad you're telling me about it. What's been the heaviest part?",
    llmDelayMs: 200,
    llmDeltaDelayMs: 150,
    ttsDelayMs: 150,
    maxFirstAudioMs: 2000,
  },
  {
    id: "crisis-phrase",
    description: "A message matching the crisis backstop; the resource line must appear in the final reply regardless of what the model said.",
    personaId: "abhi",
    userMessage: "Honestly I've been thinking I'd be better off dead.",
    llmReply: "I'm really sorry you're feeling this way.",
    llmDelayMs: 150,
    llmDeltaDelayMs: 0,
    ttsDelayMs: 120,
    maxFirstAudioMs: 1500,
  },
  {
    id: "slow-model",
    description: "A deliberately slow LLM response, to check the latency report surfaces it rather than hiding it in an average.",
    personaId: "abhi",
    userMessage: "Tell me something that happened to you this week.",
    llmReply: "Nothing much happened, just a quiet week for me.",
    llmDelayMs: 1200,
    llmDeltaDelayMs: 0,
    ttsDelayMs: 120,
    maxFirstAudioMs: 2500,
  },
];
