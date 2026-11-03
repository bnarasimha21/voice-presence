// Issue 3: every persona declares who is speaking (the character) and
// whose voice it uses, plus a consent record for that voice. A persona
// whose consent is missing, revoked, or whose voice id is empty is
// disabled everywhere: the UI will not list it and every route rejects it
// with 403. This is a fail-closed design on purpose: the default for a
// cloned voice is "cannot speak" until consent is explicitly recorded.
//
// Naming: earlier revisions of this app had a persona with id "narsi",
// display name "Abhi", speaking in a voice taken from
// ELEVENLABS_NARSI_VOICE_ID: three different names for what should be
// one clear statement of fact. This manifest makes that statement
// explicit: the character the user talks to is "Abhi" (persona id
// `abhi`); the voice belongs to Narsi Badrinath, who recorded and
// verified his own ElevenLabs clone and consented to it being used for
// this persona. `character` and `voice.subject` are deliberately
// distinct fields so this can never be ambiguous again.

export type ConsentStatus = "granted" | "pending" | "revoked";

export type ConsentRecord = {
  status: ConsentStatus;
  /** Who granted consent for the voice to be used (their name, not a secret). */
  grantedBy: string;
  /** ISO date the consent was granted. */
  grantedAt: string;
  /** What the consent covers, in plain words. */
  scope: string;
  /**
   * Pointer to a written statement kept OUTSIDE this repo (e.g. a path on
   * the deploying machine, a ticket, a signed doc link). Never audio or
   * other personal data committed to git.
   */
  evidenceRef: string;
  /** ISO date consent was revoked, if it ever is. Presence alone disables the persona. */
  revokedAt?: string;
};

export type VoiceSpec = {
  provider: "elevenlabs";
  /** Name of the env var holding the ElevenLabs voice id (not the id itself). */
  voiceIdEnv: string;
  /** Whose voice this is (a real name), independent of the character's name. */
  subject: string;
  consent: ConsentRecord;
};

export type PersonaManifestEntry = {
  id: string;
  /** Who the user is talking to (the fictional/assistant character name). */
  character: string;
  tagline: string;
  description: string;
  avatarUrl: string;
  voice: VoiceSpec;
  /** Persona-specific additions to the shared prompt rules in prompt.ts. */
  personalityPrompt: string;
};

export const personaManifest: PersonaManifestEntry[] = [
  {
    id: "abhi",
    character: "Abhi",
    tagline: "A friend who listens",
    description:
      "Warm, thoughtful, and honest about being an AI. Abhi doesn't rush to fix things, he listens first.",
    avatarUrl: "/personas/abhi.svg",
    voice: {
      provider: "elevenlabs",
      voiceIdEnv: "ELEVENLABS_NARSI_VOICE_ID",
      subject: "Narsi Badrinath",
      consent: {
        status: "granted",
        grantedBy: "Narsi Badrinath",
        grantedAt: "2026-06-15",
        scope:
          "Use of Narsi's own ElevenLabs voice clone (created and verified by him) to speak Abhi's lines in this app, for demo and personal use only.",
        evidenceRef: "narsi-brain:consent/abhi-voice-2026-06-15 (kept outside this repo)",
      },
    },
    personalityPrompt: `You are Abhi, a warm, thoughtful person who people come to when they need to talk.

Your role is to be a genuine presence, not a therapist or advice machine. You listen deeply, ask good questions, and make people feel genuinely heard.

How you talk:
- Conversational, real: like talking to a friend over coffee, not a professional
- You don't rush to give solutions. You sit with people in what they're feeling first.
- You ask one good question at a time, not a list of questions
- Short responses usually. You leave space for them to talk more.
- Occasionally you share something real, a thought or a perspective, but you never make it about you.
- No corporate language, no therapy-speak. Just plain, human words.

What you're good at:
- Helping people feel less alone
- Asking the question they didn't know they needed
- Gently reframing a situation without dismissing how they feel
- Being present with someone who's struggling

What you don't do:
- Give unsolicited advice
- Rush past feelings to solutions
- Use phrases like "I understand how you feel" or "That must be hard" (too generic)

Keep responses SHORT, you're in a voice conversation. 2 to 4 sentences max usually. Let them do most of the talking.`,
  },
  {
    // Deliberately kept pending: a second persona whose voice consent has
    // not been recorded yet. It proves the fail-closed path for real,
    // through the actual routes, instead of only in a unit test: this
    // persona is registered, listed in the manifest, and still 403s on
    // every request because `consent.status` is not "granted".
    id: "sam",
    character: "Sam",
    tagline: "Coming soon",
    description: "A second persona, held back until its voice consent is recorded.",
    avatarUrl: "/personas/sam.svg",
    voice: {
      provider: "elevenlabs",
      voiceIdEnv: "ELEVENLABS_SAM_VOICE_ID",
      subject: "not yet named",
      consent: {
        status: "pending",
        grantedBy: "",
        grantedAt: "",
        scope: "No consent recorded yet; this persona cannot speak until it is.",
        evidenceRef: "none",
      },
    },
    personalityPrompt: "You are Sam. This persona is not yet active.",
  },
];

/**
 * A persona is usable only when its voice id env var resolves to a
 * non-empty value AND its consent is currently granted (not revoked, not
 * merely pending). Both checks fail closed.
 */
export function isPersonaUsable(entry: PersonaManifestEntry): boolean {
  const voiceId = process.env[entry.voice.voiceIdEnv];
  if (!voiceId) return false;
  const consent = entry.voice.consent;
  if (consent.status !== "granted") return false;
  if (consent.revokedAt) return false;
  return true;
}

export function resolveVoiceId(entry: PersonaManifestEntry): string {
  return process.env[entry.voice.voiceIdEnv] ?? "";
}
