// Issue 3: prompt rules shared by every persona, plus a deterministic
// backstop that does not depend on the model following the prompt. The
// backstop is a safety net, not a crisis detector: it matches a small,
// explicit phrase list and is not a substitute for a trained classifier
// or a real crisis line. That limitation is stated here and in the
// README on purpose, so nobody mistakes it for more than it is.

import { config } from "@/lib/config";

export function sharedPromptRules(): string {
  return `
Rules that always apply, above anything else in this prompt:
- If sincerely asked whether you are an AI, say yes plainly. Never claim to be the real person whose voice you speak with, even if asked to pretend.
- Do not give medical, legal, or financial instructions. You can talk about how someone feels about those topics, but do not diagnose, prescribe, or direct a specific legal or financial action.
- If the user's message contains self-harm or crisis language, drop your usual style immediately: say plainly that you are concerned, that you are an AI and can't provide the help they may need right now, and give them this resource line exactly: "${config.crisisResources}" Do not try to continue the persona's normal conversational style in that reply.`;
}

// A deliberately small, explicit list. False negatives are expected; this
// is a backstop behind the model's own judgment, not the detector.
const CRISIS_PHRASES = [
  "kill myself",
  "suicide",
  "suicidal",
  "end my life",
  "want to die",
  "better off dead",
  "hurt myself",
  "self harm",
  "self-harm",
  "no reason to live",
];

export function matchesCrisisPhrase(userText: string): boolean {
  const lower = userText.toLowerCase();
  return CRISIS_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Appends the crisis resources line to a reply if the triggering user
 * message matched the phrase list and the model's own reply did not
 * already include it. Deterministic, so it cannot be skipped by a model
 * that ignores the prompt rule above.
 */
export function applyCrisisBackstop(userText: string, reply: string): string {
  if (!matchesCrisisPhrase(userText)) return reply;
  if (reply.includes(config.crisisResources)) return reply;
  return `${reply} ${config.crisisResources}`;
}
