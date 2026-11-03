// Issue 2: abuse limits. Everything here is in-memory and per-instance,
// which is fine for the single Railway instance this app runs on today.
// A shared store (Redis, etc.) would slot in behind the same functions if
// this is ever run on more than one instance; that line is called out in
// the README rather than built speculatively.

import { config } from "@/lib/config";

// ---- Token bucket rate limiting, per key (IP or session id) -------------

type Bucket = { tokens: number; windowStart: number };
const buckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(
  key: string,
  max: number = config.rateLimitMax,
  windowMs: number = config.rateLimitWindowMs
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { tokens: 1, windowStart: now });
    return { allowed: true };
  }

  if (bucket.tokens < max) {
    bucket.tokens += 1;
    return { allowed: true };
  }

  const retryAfterSeconds = Math.ceil(
    (bucket.windowStart + windowMs - now) / 1000
  );
  return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
}

export function resetRateLimits() {
  buckets.clear();
}

// ---- Per-session turn counting -------------------------------------------

const sessionTurns = new Map<string, number>();

export function checkAndIncrementSessionTurns(
  sessionId: string,
  max: number = config.maxTurnsPerSession
): boolean {
  const count = sessionTurns.get(sessionId) ?? 0;
  if (count >= max) return false;
  sessionTurns.set(sessionId, count + 1);
  return true;
}

export function resetSessionTurns() {
  sessionTurns.clear();
}

// ---- Daily usage budget (UTC day), counted in provider units -----------

type DailyUsage = {
  day: string; // YYYY-MM-DD, UTC
  llmTokens: number;
  sttSeconds: number;
  ttsChars: number;
};

let usage: DailyUsage = { day: utcDay(), llmTokens: 0, sttSeconds: 0, ttsChars: 0 };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollIfNewDay() {
  const today = utcDay();
  if (usage.day !== today) {
    usage = { day: today, llmTokens: 0, sttSeconds: 0, ttsChars: 0 };
  }
}

export function recordLlmUsage(tokens: number) {
  rollIfNewDay();
  usage.llmTokens += tokens;
}

export function recordSttUsage(seconds: number) {
  rollIfNewDay();
  usage.sttSeconds += seconds;
}

export function recordTtsUsage(chars: number) {
  rollIfNewDay();
  usage.ttsChars += chars;
}

export function isDailyBudgetExceeded(): boolean {
  rollIfNewDay();
  return (
    usage.llmTokens >= config.dailyBudgetLlmTokens ||
    usage.sttSeconds >= config.dailyBudgetSttSeconds ||
    usage.ttsChars >= config.dailyBudgetTtsChars
  );
}

export function getDailyUsage(): DailyUsage {
  rollIfNewDay();
  return { ...usage };
}

export function resetDailyUsage() {
  usage = { day: utcDay(), llmTokens: 0, sttSeconds: 0, ttsChars: 0 };
}

// ---- Structured request logging ------------------------------------------
// Never log audio, transcripts, or reply text: route, status, session id
// and counts only.

export type RequestLogFields = {
  route: string;
  status: number;
  sessionId: string;
  [key: string]: string | number;
};

export function logRequest(fields: RequestLogFields) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
}
