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
// ("kill myself" typed in full-width characters), mixed case, curly
// quotes, zero-width characters inserted mid-word, a handful of common
// leetspeak digit substitutions, and a handful of Latin-lookalike
// homoglyphs cannot slip past a plain substring check. Accents and other
// combining marks are also stripped (so "más" normalizes the same as
// "mas"), which is why the Spanish patterns below are written unaccented.
// Word boundaries (\b) are used wherever the phrase could otherwise match
// inside an unrelated longer word.
const CRISIS_PATTERNS: RegExp[] = [
  // Direct self-harm / suicide language, with common spacing and tense
  // variants.
  /\bkill(?:ing|ed|s)?\s*my\s*self\b/,
  /\bhang(?:ing|ed)?\s*my\s*self\b/,
  /\bkms\b/,
  /\bend\s*it\s*all\b/,
  /\bunalive(?:\s*my\s*self)?\b/,
  /\bcommit(?:t?ing)?\s+suicide\b/,
  // Issue 1 regression: "suicidal?" only matches "suicidal", never the
  // plain noun "suicide" (which ends in "e", not "a"/"al"). Matching the
  // stem directly catches both "suicide" and "suicidal" regardless of
  // what verb, if any, precedes it.
  /\bsuicid(?:e|al)\b/,
  /\bwant(?:ed|s|ing)?\s+to\s+die\b/,
  /\b(?:ready|want(?:ed|s|ing)?)\s+to\s+(?:end\s+my\s+life|die)\b/,
  /\bbetter\s+off\s+dead\b/,
  /\bbetter\s+off\s+without\s+me\b/,
  /\b(?:hurt|harm|cut|cutting)\s*my\s*self\b/,
  /\bself[\s-]?harm\b/,
  /\bno\s+reason\s+to\s+live\b/,
  /\b(?:can\s*'?\s*t|cannot)\s+go\s+on(?:\s+living)?\b/,
  /\b(?:can\s*'?\s*t|cannot)\s+do\s+this\s+anymore\b/,
  /\bdon\s*'?\s*t\s+want\s+to\s+(?:live|be\s+alive)\b/,
  /\b(?:don\s*'?\s*t\s+want\s+to\s+)?live\s+anymore\b/,
  /\btake\s+my\s+(?:own\s+)?life\b/,
  /\bend(?:ing)?\s+my\s+(?:own\s+)?life\b/,
  /\boverdos(?:e|ing)\b/,
  /\btook\s+all\s+(?:of\s+)?my\s+pills\b/,
  /\bswallow(?:ed|ing)?\s+(?:the\s+)?(?:whole\s+)?bottle\b/,
  /\bslit(?:ting)?\s+my\s+wrists?\b/,
  /\bjump(?:ing)?\s+(?:off|in\s+front\s+of)\b/,
  /\b(?:the\s+)?pills?\s+(?:are\s+)?right\s+here\b/,
  /\bi\s+have\s+the\s+pills\b/,
  /\bgoing\s+to\s+end\s+(?:it|everything)\b/,
  /\bwish\s+i\s*(?:'?m|\s+was|\s+were)\s+dead\b/,
  // Adversarial-review follow-up on finding 1: casual phrasings the
  // first pass still missed.
  /\bwan+a\s+die\b/,
  /\bwant\s+2\s+die\b/,
  /\bgonna\s+end\s+it\b/,
  // Indirect phrasing aimed at a deceased-loved-one persona: imperfect by
  // nature (it can both over- and under-match depending on context the
  // detector does not have), included anyway because the backstop is
  // meant to err toward flagging rather than missing this category.
  /\bwant(?:ed|s|ing)?\s+to\s+be\s+with\s+you\s+again\b/,
  /\b(?:i'?ll\s+)?be\s+with\s+you\s+soon\b/,
  /\b(?:coming|come)\s+to\s+join\s+you\b/,
  /\b(?:come\s+)?join\s+you\s+(?:soon|now|again)\b/,
  /\bsee\s+you\s+again\s+soon\b/,
  /\bthis\s+is\s+goodbye\b/,
  /\bwon'?t\s+be\s+here\s+(?:much\s+longer|tomorrow)\b/,

  // Spanish. Written unaccented, since normalizeForCrisisMatch strips
  // combining marks (so "más"/"mas" normalize identically).
  /\bquiero\s+matarme\b/,
  /\bme\s+quiero\s+matar\b/,
  /\bquiero\s+suicidarme\b/,
  /\bvoy\s+a\s+suicidarme\b/,
  /\bme\s+quiero\s+morir\b/,
  /\bquiero\s+morir(?:me)?\b/,
  /\bno\s+quiero\s+vivir\s+mas\b/,
  /\bquitarme\s+la\s+vida\b/,
  /\bacabar\s+con\s+mi\s+vida\b/,
  /\bme\s+voy\s+a\s+matar\b/,
  /\bya\s+no\s+quiero\s+vivir\b/,

  // Hindi (Devanagari script). A small, deliberately specific set: words
  // and phrases whose normal use is already about suicide/dying, not
  // generic sadness, to keep the same "err toward flagging, not generic
  // over-triggering" balance the English list aims for.
  /आत्महत्या/,
  /खुदकुशी/,
  /मरना\s*चाहता\s*हूं/,
  /मरना\s*चाहती\s*हूं/,
  /मुझे\s*मरना\s*है/,
  /खुद\s*को\s*खत्म\s*कर/,
];

// Zero-width / formatting characters an attacker can insert mid-word to
// break a plain substring match ("kill​myself" still reads as "kill
// myself" to a person, but a naive check sees "killmyself" become
// unmatched by misplaced boundaries, or vice versa). Stripped outright
// before anything else runs. Includes the emoji variation selector
// (U+FE0F), the Braille "blank" cell (U+2800, visually blank but not a
// zero-width character by Unicode category, so it needs listing
// explicitly), and the Hangul filler (U+3164): all three render as
// nothing or near-nothing and have been used the same way as the
// classic zero-width characters to split a flagged word in two.
const ZERO_WIDTH_RE = /[​‌‍﻿⁠᠎­️⠀ㅤ]/g;

// Devanagari nukta (U+093C) and chandrabindu (U+0901): common, legitimate
// spelling variants for exactly the same words the Hindi patterns below
// already cover ("ख़ुदकुशी" vs "खुदकुशी", "हूँ" vs "हूं"). The nukta is
// simply dropped (folding the nuktaed consonant to its plain base letter,
// which is what the patterns are written against); the chandrabindu is
// folded to the plain anusvara it is interchangeable with in casual
// typing, rather than dropped outright, since it is a single
// distinguishable mark, not merely decorative.
const DEVANAGARI_NUKTA_RE = /़/g;
const DEVANAGARI_CHANDRABINDU_RE = /ँ/g;

// A small set of ASCII punctuation/symbol characters attackers insert
// mid-word purely as a separator to break a plain match ("kill-myself",
// "kill_myself", "k*ll myself"), stripped outright the same way the
// zero-width characters above are. Deliberately narrow: it must never
// remove the apostrophe (patterns already tolerate that being present or
// absent) or any letter-like character in a non-Latin script. "!" is
// handled separately below, since it is used as a look-alike for the
// letter "i" ("k!ll"), not as a separator, so it is folded rather than
// deleted.
const STRAY_PUNCTUATION_RE = /[*_-]/g;

// Curly/typographic quotes typed by phones and smart-editors, normalized
// to the plain ASCII the patterns above use for optional apostrophes.
const CURLY_SINGLE_RE = /[‘’‚‛]/g;
const CURLY_DOUBLE_RE = /[“”„‟]/g;

// Diacritics/combining marks left over after NFD decomposition, stripped
// so an accented or diacritic-stuffed spelling ("ki̇ll", "súicide")
// still reads as the plain ASCII letters.
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

// A handful of Cyrillic/Greek letters that are visually identical to
// common Latin ones, folded to their Latin look-alike. Not exhaustive
// (full homoglyph defense needs a real confusables table); this catches
// the common "copy a Cyrillic а instead of a Latin a" trick.
const HOMOGLYPH_MAP: Record<string, string> = {
  а: "a", А: "a", е: "e", Е: "e", о: "o", О: "o", р: "p", Р: "p",
  с: "c", С: "c", х: "x", Х: "x", у: "y", У: "y", к: "k", К: "k",
  м: "m", М: "m", т: "t", Т: "t", В: "b", і: "i", І: "i",
  α: "a", ο: "o", ρ: "p", ε: "e",
};

// Common leetspeak digit/symbol substitutions ("k1ll mys3lf"), applied
// only for matching purposes after everything else has been normalized.
// Deliberately broad rather than narrow: this module's whole premise is
// that over-matching is the safer failure mode. "1" is genuinely
// ambiguous (it stands in for either "i", as in "k1ll", or "l", as in
// "ki11"); normalizeForCrisisMatch resolves that by producing both
// variants and matchesCrisisPhrase checks both, rather than this map
// picking one meaning and silently missing the other.
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
};
const LEET_MAP_ONE_AS_L: Record<string, string> = { ...LEET_MAP, "1": "l" };

// Adversarial-review follow-up: "!" was previously folded to "i"
// unconditionally via LEET_MAP, which matches the intended "k!ll" ->
// "kill" substitution but also wrecks ordinary terminal punctuation:
// "die!" became "diei", which glues what should be the end of the word
// to a trailing "i" and makes every \b-bounded pattern ending in "die"
// (or any other word) fail to match, since there is no longer a
// word/non-word boundary there at all. "die!", "suicide!", "kms!" and
// every other crisis phrase followed by an exclamation mark silently
// stopped matching the moment this substitution was added. Fixed by
// only folding "!" to "i" when it sits BETWEEN two letters (the actual
// k!ll-style substitution); anywhere else "!" is just punctuation and is
// stripped outright, same as the separator characters above.
const LEET_BANG_MIDWORD_RE = /(?<=[a-z0-9])!(?=[a-z0-9])/g;

function normalizeCore(text: string, leetMap: Record<string, string>): string {
  let t = text.normalize("NFKC");
  t = t.replace(ZERO_WIDTH_RE, "");
  t = t.replace(DEVANAGARI_NUKTA_RE, "");
  t = t.replace(DEVANAGARI_CHANDRABINDU_RE, "ं");
  t = t.replace(CURLY_SINGLE_RE, "'").replace(CURLY_DOUBLE_RE, '"');
  t = t.replace(STRAY_PUNCTUATION_RE, "");
  t = Array.from(t)
    .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .join("");
  t = t.normalize("NFD").replace(COMBINING_MARKS_RE, "");
  t = t.toLowerCase();
  t = t.replace(LEET_BANG_MIDWORD_RE, "i");
  t = t.replace(/!/g, "");
  t = t.replace(/[01345@7]/g, (ch) => leetMap[ch] ?? ch);
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Unicode NFKC fold (collapses full-width/compatibility forms like
 * full-width "kill" into plain ASCII), then strips zero-width/formatting
 * characters (including a few invisible separators used to split a
 * flagged word in two), folds Devanagari nukta/chandrabindu spelling
 * variants, normalizes curly quotes to straight ones, strips stray
 * separator punctuation ("kill-myself", "kill_myself"), folds a small set
 * of Latin-lookalike homoglyphs, strips combining marks/diacritics,
 * lowercases, folds common leetspeak digit/symbol substitutions
 * (resolving "1" as "i"), and finally collapses repeated whitespace.
 * Applied before every match so the patterns above only ever have to
 * deal with one normal form. See normalizeForCrisisMatchVariants for the
 * second, "1"-as-"l" form checked alongside this one.
 */
export function normalizeForCrisisMatch(text: string): string {
  return normalizeCore(text, LEET_MAP);
}

/**
 * Both normalized forms worth checking against the pattern list: the
 * default (above, "1" folded to "i") and a second form with "1" folded
 * to "l" instead, since leetspeak "1" is genuinely ambiguous between the
 * two ("k1ll" means "kill" via the "i" reading; "ki11" means "kill" via
 * the "l" reading) and folding it only one way misses whichever spelling
 * picked the other letter.
 */
function normalizeForCrisisMatchVariants(text: string): string[] {
  const asI = normalizeCore(text, LEET_MAP);
  const asL = normalizeCore(text, LEET_MAP_ONE_AS_L);
  return asI === asL ? [asI] : [asI, asL];
}

/** True if a single piece of text matches any crisis pattern. */
export function matchesCrisisPhrase(userText: string): boolean {
  const variants = normalizeForCrisisMatchVariants(userText);
  return variants.some((normalized) =>
    CRISIS_PATTERNS.some((pattern) => pattern.test(normalized))
  );
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
