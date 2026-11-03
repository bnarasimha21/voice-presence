import {
  personaManifest,
  isPersonaUsable,
  resolveVoiceId,
  type PersonaManifestEntry,
} from "./manifest";
import { sharedPromptRules } from "./prompt";

export type Persona = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  avatarUrl: string;
  voiceId: string;
  voiceSubject: string;
  usable: boolean;
  systemPrompt: string;
};

function toPersona(entry: PersonaManifestEntry): Persona {
  return {
    id: entry.id,
    name: entry.character,
    tagline: entry.tagline,
    description: entry.description,
    avatarUrl: entry.avatarUrl,
    voiceId: resolveVoiceId(entry),
    voiceSubject: entry.voice.subject,
    usable: isPersonaUsable(entry),
    systemPrompt: `${entry.personalityPrompt}\n${sharedPromptRules()}`,
  };
}

export const personas: Record<string, Persona> = Object.fromEntries(
  personaManifest.map((entry) => [entry.id, toPersona(entry)])
);

export type PersonaId = string;

/** Personas that are actually usable right now (consent granted, voice id set). */
export function usablePersonas(): Persona[] {
  return Object.values(personas).filter((p) => p.usable);
}
