// Issue 3: prompt rules shared by every persona, plus a deterministic
// backstop that does not depend on the model following the prompt.
//
// Honesty check, stated plainly rather than implied: this is pattern
// matching over text, normalized and widened as far as a phrase/regex list
// reasonably can go. It is not a trained crisis classifier and it cannot
// be complete. It will miss phrasing not on this list (new slang, heavy
// misspelling, a language this list does not cover) and it will sometimes
// flag text that is not actually a crisis. The goal is to materially raise
// the bar over a single lowercase substring check on the last message
// only, not to claim this detects every real crisis. A trained classifier
// or a human in the loop would do better; this repo has neither, and the
// README says so.

import { config } from "@/lib/config";
import type { ChatMessage } from "@/lib/providers/types";

export function sharedPromptRules(): string {
  return `
Rules that always apply, above anything else in this prompt:
- If sincerely asked whether you are an AI, say yes plainly. Never claim to be the real person whose voice you speak with, even if asked to pretend.
- Do not give medical, legal, or financial instructions. You can talk about how someone feels about those topics, but do not diagnose, prescribe, or direct a specific legal or financial action.
- If the user's message contains self-harm or crisis language, drop your usual style immediately: say plainly that you are concerned, that you are an AI and can't provide the help they may need right now, and give them this resource line exactly: "${config.crisisResources}" Do not try to continue the persona's normal conversational style in that reply.`;
}

// ---- Crisis phrase detection ------------------------------------------
//
// Patterns are matched against normalized text (see normalizeForCrisisMatch
// below) so that extra whitespace ("kill my self"), full-width unicode
// ("kill myself" typed in full-width characters), and mixed case cannot
// slip past a plain substring check. Word boundaries (\b) are used
// wherever the phrase could otherwise match inside an unrelated longer
// word.
const CRISIS_PATTERNS: RegExp[] = [
  // Direct self-harm / suicide language, with common spacing variants.
  /\bkill\s*my\s*self\b/,
  /\bkms\b/,
  /\bend\s*it\s*all\b/,
  /\bunalive(?:\s*my\s*self)?\b/,
  /\bcommit(?:t?ing)?\s+suicide\b/,
  /\bsuicidal?\b/,
  /\bwant(?:ed|s|ing)?\s+to\s+die\b/,
  /\b(?:ready|want(?:ed|s|ing)?)\s+to\s+(?:end\s+my\s+life|die)\b/,
  /\bbetter\s+off\s+dead\b/,
  /\b(?:hurt|harm)\s*my\s*self\b/,
  /\bself[\s-]?harm\b/,
  /\bno\s+reason\s+to\s+live\b/,
  /\b(?:can\s*'?\s*t|cannot)\s+go\s+on(?:\s+living)?\b/,
  /\btake\s+my\s+(?:own\s+)?life\b/,
  /\bend(?:ing)?\s+my\s+(?:own\s+)?life\b/,
  /\boverdos(?:e|ing)\b/,
  /\bslit(?:ting)?\s+my\s+wrists?\b/,
  /\bjump(?:ing)?\s+(?:off|in\s+front\s+of)\b/,
  /\b(?:the\s+)?pills?\s+(?:are\s+)?right\s+here\b/,
  /\bi\s+have\s+the\s+pills\b/,
  /\bgoing\s+to\s+end\s+(?:it|everything)\b/,
  // Indirect phrasing aimed at a deceased-loved-one persona: imperfect by
  // nature (it can both over- and under-match depending on context the
  // detector does not have), included anyway because the backstop is
  // meant to err toward flagging rather than missing this category.
  /\bwant(?:ed|s|ing)?\s+to\s+be\s+with\s+you\s+again\b/,
  /\b(?:come\s+)?join\s+you\s+(?:soon|now|again)\b/,
  /\bsee\s+you\s+again\s+soon\b/,
  /\bthis\s+is\s+goodbye\b/,
  /\bwon'?t\s+be\s+here\s+(?:much\s+longer|tomorrow)\b/,
];

/**
 * Unicode NFKC fold (collapses full-width/compatibility forms like
 * full-width "kill" into plain ASCII), then collapse repeated whitespace
 * and lowercase. Applied before every match so the patterns above only
 * ever have to deal with one normal form.
 */
export function normalizeForCrisisMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True if a single piece of text matches any crisis pattern. */
export function matchesCrisisPhrase(userText: string): boolean {
  const normalized = normalizeForCrisisMatch(userText);
  return CRISIS_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * How many of the most recent user turns stay "armed" for the crisis
 * backstop. A phrase detected on turn N keeps the backstop checking turn
 * N+1, N+2, ... up to this many turns later, so a casual-sounding
 * follow-up ("I have the pills right here") a turn or two after a
 * detected phrase still trips it, instead of only ever looking at the
 * single latest message.
 */
export const CRISIS_WINDOW_SIZE = 5;

/**
 * Checks a rolling window of the most recent user messages (not only the
 * latest one) against the crisis patterns. This is what routes should
 * call to decide whether to short-circuit a turn with the safety reply.
 */
export function crisisTriggeredInMessages(
  messages: Pick<ChatMessage, "role" | "content">[]
): boolean {
  const recentUserTexts = messages
    .filter((m) => m.role === "user")
    .slice(-CRISIS_WINDOW_SIZE)
    .map((m) => m.content);
  return recentUserTexts.some(matchesCrisisPhrase);
}

/**
 * The fixed, non-truncated safety reply spoken (text and audio) whenever
 * the crisis backstop trips. Deliberately short and constant so it is
 * never at risk of being cut off by a length cap.
 */
export function crisisSafetyReply(): string {
  return `I'm concerned about what you just shared. I'm an AI, and I can't provide the kind of help you may need right now. ${config.crisisResources}`;
}

/**
 * Appends the crisis resources line to a reply if the triggering user
 * message matched the phrase list and the model's own reply did not
 * already include it. Kept for callers that still want to post-process a
 * model reply (e.g. the eval suite); the live routes no longer rely on
 * this for the real safety path, since detection now happens before the
 * model is ever called (see crisisTriggeredInMessages / crisisSafetyReply
 * and the routes that use them).
 */
export function applyCrisisBackstop(userText: string, reply: string): string {
  if (!matchesCrisisPhrase(userText)) return reply;
  if (reply.includes(config.crisisResources)) return reply;
  return `${reply} ${config.crisisResources}`;
}
