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
  // Finding 4 (adversarial review, second pass): the rate-limit buckets
  // map had no expiry at all, unlike sessionTurns below. Once Finding 4's
  // IP fallback in lib/request-context.ts started handing out stable,
  // reused keys (e.g. "ip:1.2.3.4") instead of a fresh UUID per
  // cookie-less request, an entry for a given key is created once and
  // then never removed, even long after that IP stopped sending
  // requests. A TTL well past the rate-limit window itself (so it never
  // interferes with an in-progress window) plus the same cap-eviction
  // pattern as sessionTurns keeps this map bounded.
  rateLimitBucketTtlMs: int("RATE_LIMIT_BUCKET_TTL_MS", 10 * 60_000), // 10 min

  // Finding 4 follow-up (adversarial review, second pass): /api/stt is
  // the one route a crisis message must pass through before the crisis
  // check can even run (the UI is voice-only). The default rateLimitMax
  // (20/min) is sized for a single browser's own turns; sharing it
  // verbatim for the per-IP fallback key means several real people
  // behind one NAT, or any client reaching this app through a CDN/proxy
  // that does not forward a usable X-Forwarded-For, can exhaust it on
  // ordinary use and then have a genuine crisis utterance 429 before it
  // is ever transcribed. STT is no longer gated by the daily budget
  // (finding 2), so a materially higher per-key ceiling here still
  // bounds cost/abuse without making shared-IP crisis transcription the
  // first thing to break.
  sttRateLimitMax: int("STT_RATE_LIMIT_MAX", 60),

  // Finding 5 (third adversarial review): lib/crisis-audio-cache.ts used
  // to only reject a zero-length synthesis body before caching it, even
  // though its own comment claimed "empty or truncated" bodies were
  // rejected. A stream that ends early but cleanly (cut off mid-sentence,
  // e.g. before the "call 988" line) is nonzero length and was cached as
  // if it were the real, complete safety audio, then served on every
  // future crisis trigger until the process restarted.
  //
  // Finding 5 follow-up (fourth adversarial review, two rounds): a flat
  // bytes-per-char floor cannot do this job well, because real bytes/char
  // depends entirely on TTS_OUTPUT_FORMAT's bitrate. A flat 20 was
  // "theater" (only caught >98% truncation at the default 128kbps
  // format). Raising it to a flat 300 fixed that for the default format,
  // but then falsely rejected genuinely complete audio at a low-bitrate
  // format (e.g. mp3_44100_32, 32kbps: full audio is only ~286
  // bytes/char there, below a flat 300 floor) -- one env var away from
  // every crisis trigger permanently failing to produce audio. One flat
  // number cannot both avoid that false-reject and still catch a
  // realistic partial truncation at the default bitrate.
  //
  // The real fix (lib/crisis-audio-cache.ts) now derives the floor from
  // the actual output format's bitrate/sample rate, using
  // assumedMaxSpeakingCharsPerSecond below as a deliberately fast
  // (safety-margin) speaking rate, so the floor scales with whatever
  // format is actually configured instead of assuming one bitrate.
  // minCrisisAudioBytesPerChar is now only a fallback, used when the
  // output format string cannot be parsed into a known bitrate/sample
  // rate (so the dynamic calculation has nothing to divide), or when a
  // deployer wants to force a specific value regardless of format.
  minCrisisAudioBytesPerChar: int("MIN_CRISIS_AUDIO_BYTES_PER_CHAR", 300),

  // Finding 5 follow-up (fourth adversarial review): the fastest realistic
  // spoken rate assumed when deriving the crisis-audio truncation floor
  // from an output format's bitrate (see lib/crisis-audio-cache.ts). This
  // is deliberately on the fast side (most real speech is slower, closer
  // to 12-15 chars/sec) so a genuinely fast voice reading complete audio
  // is never mistaken for truncated audio; the resulting floor is still
  // well below a typical-speed complete recording, leaving room to catch
  // a real partial cut.
  //
  // Finding 1 (fourth adversarial review, third pass): 25 left too much
  // slack. At the default 128kbps format, dividing by 25 gave a floor of
  // only ~640 bytes/char, below half of a typical complete recording
  // (~1250 bytes/char), so a stream that produced real audio for roughly
  // 79% of the reply and then silently dropped only the trailing "call
  // 988" resources sentence still cleared the floor and got cached as
  // complete.
  //
  // Finding 1 (fourth adversarial review, fourth pass): the first fix for
  // this lowered the value all the way to 16, which overcorrected. Plain
  // conversational English already runs close to 15 chars/sec at ~150
  // words/min (avg. word length ~5 chars + a space), and a brisk voice,
  // or a voice sped up via the provider's own speed control, can exceed
  // 20. A rejection here is NOT a hard failure: getCachedCrisisAudio's
  // caller degrades to text-only on a cache miss/error rather than
  // erroring the whole crisis reply. But this app's UI is voice-only, so
  // "text-only" is a real degradation of the one safety path this app
  // cannot afford to lose, not a cosmetic one, and at 16 a normal fast
  // voice reading the fixed safety line could be misclassified as
  // truncated EVERY time (same text, same voice, same result on every
  // retry), silently losing crisis audio for that persona permanently
  // until someone notices and raises this value by hand.
  //
  // Settled on 20: still comfortably at or above a brisk real speaking
  // rate, so genuinely complete audio is not misread as truncated, while
  // still tighter than the original 25 (catches losing roughly a third
  // or more of the audio instead of needing to lose about half). This
  // remains a heuristic byte-count comparison, not a real decode: a
  // partial cut small enough to stay above whatever floor is configured
  // will still get through, and an unusually fast voice configuration
  // should raise this value further via env rather than rely on the
  // default blindly.
  assumedMaxSpeakingCharsPerSecond: int("ASSUMED_MAX_SPEAKING_CHARS_PER_SECOND", 20),

  // Adversarial-review follow-up on finding 3: the crisis-audio cache
  // (lib/crisis-audio-cache.ts) dedupes concurrent first-use synthesis
  // calls behind a single in-flight promise, so a slow/stalled provider
  // response now blocks every crisis trigger across every session, not
  // just the one caller that happened to go first (before the cache
  // existed, each request made its own independent provider call). A
  // bounded timeout on that one synthesis call means a stalled provider
  // fails fast instead of leaving every waiting crisis reply silent for
  // minutes; the next caller then gets a fresh attempt.
  crisisAudioTimeoutMs: int("CRISIS_AUDIO_TIMEOUT_MS", 15_000),
  dailyBudgetLlmTokens: int("DAILY_BUDGET_LLM_TOKENS", 500_000),
  dailyBudgetSttSeconds: int("DAILY_BUDGET_STT_SECONDS", 7200),
  dailyBudgetTtsChars: int("DAILY_BUDGET_TTS_CHARS", 500_000),

  // Issue 5: bounded, self-expiring session turn counts so a session key
  // (especially a shared "anon:unknown-ip" key) cannot grow the map
  // forever or stay permanently blocked once it hits the cap.
  sessionTurnsTtlMs: int("SESSION_TURNS_TTL_MS", 24 * 60 * 60_000), // 24h
  maxSessionEntries: int("MAX_SESSION_ENTRIES", 50_000),

  // Issue 6: a worst-case seconds reservation for one STT call, used only
  // to make the daily STT-seconds budget check atomic (reserve before the
  // call, settle to the real value after). Generous on purpose: a false
  // reservation that is too low is what causes the race this exists to
  // close.
  sttReservationSeconds: int("STT_RESERVATION_SECONDS", 120),

  turnSecret: process.env.TURN_SECRET ?? "",
  replyTokenTtlMs: int("REPLY_TOKEN_TTL_MS", 2 * 60_000),
  accessCode: process.env.ACCESS_CODE ?? "",
  // Issue 8: the access-gate cookie is signed with its own secret, never
  // with the access code itself (signing with the code would let the
  // cookie's signature double as a way to confirm/guess the code).
  // Falls back to TURN_SECRET only so a deploy that already set one
  // secret does not need two to get the fixed signing scheme; setting a
  // distinct ACCESS_COOKIE_SECRET is still recommended.
  accessCookieSecret: process.env.ACCESS_COOKIE_SECRET ?? process.env.TURN_SECRET ?? "",
  // Issue 5: the session-identity cookie is signed separately so it can
  // be rotated independently of the other two secrets.
  sessionCookieSecret: process.env.SESSION_COOKIE_SECRET ?? process.env.TURN_SECRET ?? "",
  voiceEnabled: bool("VOICE_ENABLED", true),

  // Issue 3: disclosure / crisis resources. This app has no way to know
  // the user's country, so the default is a real, usable, international
  // default rather than a vague instruction: findahelpline.com (a
  // directory of crisis lines by country) plus the US 988 Suicide and
  // Crisis Lifeline as a concrete fallback. A deployer who knows their
  // audience's country should set CRISIS_RESOURCES to a localized line.
  crisisResources:
    process.env.CRISIS_RESOURCES ??
    "If you are in immediate danger, please contact your local emergency number. You can find a crisis line for your country at findahelpline.com. In the US, you can call or text 988 (Suicide and Crisis Lifeline) anytime.",

  // Issue 16: TURN_SECRET ships a placeholder in .env.example; refuse to
  // boot in production if it was copied verbatim or is too short to be a
  // real secret.
  minSecretLength: int("MIN_SECRET_LENGTH", 16),
};

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// Issue 16: known placeholder values that must never be used verbatim in
// production. Keep this list in sync with .env.example's placeholders.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "",
  "REPLACE_ME",
  "REPLACE_ME_WITH_A_RANDOM_SECRET",
  "sk-ant-REPLACE_ME",
  "test-secret-do-not-use-in-prod",
]);

export type SecretCheckFailure = { name: string; reason: "placeholder" | "too-short" };

/**
 * Checks every secret this app signs tokens/cookies with against the
 * known placeholder list and a minimum length. Returns the list of
 * failures (empty if everything looks like a real secret); callers decide
 * what to do with that (the production boot check refuses to start).
 */
export function checkSecretsForPlaceholders(): SecretCheckFailure[] {
  const failures: SecretCheckFailure[] = [];
  const candidates: [string, string][] = [
    ["TURN_SECRET", config.turnSecret],
    ["ACCESS_COOKIE_SECRET", config.accessCookieSecret],
    ["SESSION_COOKIE_SECRET", config.sessionCookieSecret],
  ];
  for (const [name, value] of candidates) {
    if (KNOWN_PLACEHOLDER_SECRETS.has(value)) {
      failures.push({ name, reason: "placeholder" });
    } else if (value.length < config.minSecretLength) {
      failures.push({ name, reason: "too-short" });
    }
  }
  return failures;
}

/**
 * Call once at startup. Throws in production if any secret is a known
 * placeholder or too short, so a deploy that copied .env.example verbatim
 * fails to boot instead of silently running with a guessable secret.
 * A no-op outside production, so local dev and CI are unaffected.
 */
export function assertSecretsAreRealInProduction(): void {
  if (!isProduction()) return;
  const failures = checkSecretsForPlaceholders();
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.name} (${f.reason})`).join(", ");
    throw new Error(
      `Refusing to start in production with an unsafe secret: ${detail}. ` +
        "Generate real random values (e.g. openssl rand -hex 32) and set them as env vars."
    );
  }
}
