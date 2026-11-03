// Issue 2: abuse limits. Everything here is in-memory and per-instance,
// which is fine for the single Railway instance this app runs on today.
// A shared store (Redis, etc.) would slot in behind the same functions if
// this is ever run on more than one instance; that line is called out in
// the README rather than built speculatively.

import { config } from "@/lib/config";

// ---- Token bucket rate limiting, per key (IP or session id) -------------

type Bucket = { tokens: number; windowStart: number };
const buckets = new Map<string, Bucket>();

// Finding 4 (adversarial review, second pass): bounded and self-expiring,
// same pattern as sweepSessionTurns below. Before this, a key that
// resolveSession (lib/request-context.ts) hands out for a cookie-less
// request (now a stable "ip:<address>" key, not a fresh UUID per
// request) created one entry here forever: nothing ever deleted it, so
// the map grew by one distinct key per distinct client IP ever seen,
// without bound, for the lifetime of the process.
function sweepBuckets(now: number) {
  const ttl = config.rateLimitBucketTtlMs;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > ttl) buckets.delete(key);
  }
  const max = config.maxSessionEntries;
  if (buckets.size > max) {
    const oldestFirst = [...buckets.entries()].sort(
      (a, b) => a[1].windowStart - b[1].windowStart
    );
    const excess = buckets.size - max;
    for (let i = 0; i < excess; i++) buckets.delete(oldestFirst[i][0]);
  }
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkRateLimit(
  key: string,
  max: number = config.rateLimitMax,
  windowMs: number = config.rateLimitWindowMs
): RateLimitResult {
  const now = Date.now();
  sweepBuckets(now);
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { tokens: 1, windowStart: now });
    // Sweep again after inserting: a brand-new key is what can push this
    // map over the cap, so the cap-eviction pass must see it to actually
    // bring the map back down to size, not just to one-over on this call.
    sweepBuckets(now);
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

/** Test-only: how many live entries the rate-limit buckets map currently holds. */
export function bucketsSize(): number {
  return buckets.size;
}

// ---- Per-session turn counting -------------------------------------------
//
// Issue 5: bounded and self-expiring. A session key is never kept forever
// (a TTL sweep forgets it, so a key that hit the cap is not permanently
// blocked) and the map is capped at config.maxSessionEntries (oldest
// entries evicted first), so a flood of distinct spoofed keys cannot grow
// this map without bound.

type SessionTurnEntry = { count: number; lastSeen: number };
const sessionTurns = new Map<string, SessionTurnEntry>();

function sweepSessionTurns(now: number) {
  const ttl = config.sessionTurnsTtlMs;
  for (const [key, entry] of sessionTurns) {
    if (now - entry.lastSeen > ttl) sessionTurns.delete(key);
  }
  const max = config.maxSessionEntries;
  if (sessionTurns.size > max) {
    const oldestFirst = [...sessionTurns.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen
    );
    const excess = sessionTurns.size - max;
    for (let i = 0; i < excess; i++) sessionTurns.delete(oldestFirst[i][0]);
  }
}

export function checkAndIncrementSessionTurns(
  sessionId: string,
  max: number = config.maxTurnsPerSession,
  now: number = Date.now()
): boolean {
  sweepSessionTurns(now);
  const entry = sessionTurns.get(sessionId);
  const count = entry?.count ?? 0;
  if (count >= max) return false;
  sessionTurns.set(sessionId, { count: count + 1, lastSeen: now });
  return true;
}

export function resetSessionTurns() {
  sessionTurns.clear();
}

/** Test-only: how many live entries the session-turns map currently holds. */
export function sessionTurnsSize(): number {
  return sessionTurns.size;
}

// ---- Daily usage budget (UTC day), counted in provider units -----------

type BudgetKind = "llmTokens" | "sttSeconds" | "ttsChars";

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

function budgetFor(kind: BudgetKind): number {
  if (kind === "llmTokens") return config.dailyBudgetLlmTokens;
  if (kind === "sttSeconds") return config.dailyBudgetSttSeconds;
  return config.dailyBudgetTtsChars;
}

// Issue 6: the budget check and the budget increment used to happen in
// two separate steps with a provider call (and therefore an await) in
// between, so N concurrent requests could all pass the check before any
// of them recorded usage, overshooting the budget by up to N times the
// per-request amount. `reserveBudget` is a single synchronous
// function: it reads and writes `usage` with no `await` anywhere inside
// it, so under Node's single-threaded event loop no other request's code
// can run between the read and the write. That makes "check, then
// reserve" atomic without needing a lock. Callers reserve a worst-case
// estimate *before* the provider call, then call `settleBudget` to
// correct the reservation down (or up) to the real value once it is
// known, or `releaseBudget` to fully roll the reservation back if the
// call failed.

export function reserveBudget(kind: BudgetKind, amount: number): boolean {
  rollIfNewDay();
  if (usage[kind] + amount > budgetFor(kind)) return false;
  usage[kind] += amount;
  return true;
}

export function settleBudget(kind: BudgetKind, reserved: number, actual: number) {
  rollIfNewDay();
  usage[kind] += actual - reserved;
  if (usage[kind] < 0) usage[kind] = 0;
}

export function releaseBudget(kind: BudgetKind, reserved: number) {
  settleBudget(kind, reserved, 0);
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
