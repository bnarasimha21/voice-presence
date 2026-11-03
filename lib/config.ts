// Single place for env-driven configuration. No vendor model id, limit, or
// secret should be hardcoded anywhere else in the app; read it from here.

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = {
  // Issue 1: provider seam selection. "fake" throws if used in production.
  providers: (process.env.VOICE_PROVIDERS ?? "real") as "real" | "fake",

  // Issue 4: model ids as config, never literals in route code.
  llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
  sttModel: process.env.STT_MODEL ?? "nova-2",
  ttsModel: process.env.TTS_MODEL ?? "eleven_flash_v2_5",
  ttsOutputFormat: process.env.TTS_OUTPUT_FORMAT ?? "mp3_44100_128",
  maxReplyTokens: int("MAX_REPLY_TOKENS", 256),

  // Issue 2: abuse limits and budgets.
  maxSttBytes: int("MAX_STT_BYTES", 5 * 1024 * 1024), // 5 MB
  maxChatMessages: int("MAX_CHAT_MESSAGES", 40),
  maxChatChars: int("MAX_CHAT_CHARS", 8000),
  maxSpokenChars: int("MAX_SPOKEN_CHARS", 2000),
  maxTurnsPerSession: int("MAX_TURNS_PER_SESSION", 60),
  rateLimitWindowMs: int("RATE_LIMIT_WINDOW_MS", 60_000),
  rateLimitMax: int("RATE_LIMIT_MAX", 20),
  dailyBudgetLlmTokens: int("DAILY_BUDGET_LLM_TOKENS", 500_000),
  dailyBudgetSttSeconds: int("DAILY_BUDGET_STT_SECONDS", 7200),
  dailyBudgetTtsChars: int("DAILY_BUDGET_TTS_CHARS", 500_000),

  turnSecret: process.env.TURN_SECRET ?? "",
  replyTokenTtlMs: int("REPLY_TOKEN_TTL_MS", 2 * 60_000),
  accessCode: process.env.ACCESS_CODE ?? "",
  voiceEnabled: bool("VOICE_ENABLED", true),

  // Issue 3: disclosure / crisis resources.
  crisisResources:
    process.env.CRISIS_RESOURCES ??
    "If you are in immediate danger, please contact your local emergency number.",
};

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
