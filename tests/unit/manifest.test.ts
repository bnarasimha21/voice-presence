import { describe, it, expect } from "vitest";
import { personaManifest, isPersonaUsable } from "@/lib/personas/manifest";

describe("persona manifest integrity", () => {
  it("every persona has both character and voice.subject set", () => {
    for (const entry of personaManifest) {
      expect(entry.character.length).toBeGreaterThan(0);
      expect(entry.voice.subject.length).toBeGreaterThan(0);
    }
  });

  it("no two personas share a voice id env var", () => {
    const envVars = personaManifest.map((p) => p.voice.voiceIdEnv);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("every persona has a consent record with a status", () => {
    for (const entry of personaManifest) {
      expect(["granted", "pending", "revoked"]).toContain(entry.voice.consent.status);
      expect(entry.voice.consent.evidenceRef.length).toBeGreaterThan(0);
    }
  });
});

describe("isPersonaUsable", () => {
  const base = personaManifest[0];

  it("is false when the voice id env var is unset", () => {
    const original = process.env[base.voice.voiceIdEnv];
    delete process.env[base.voice.voiceIdEnv];
    expect(isPersonaUsable(base)).toBe(false);
    if (original !== undefined) process.env[base.voice.voiceIdEnv] = original;
  });

  it("is false when consent is revoked, even with a voice id set", () => {
    process.env[base.voice.voiceIdEnv] = "some-voice-id";
    const revoked = {
      ...base,
      voice: {
        ...base.voice,
        consent: { ...base.voice.consent, status: "granted" as const, revokedAt: "2026-01-01" },
      },
    };
    expect(isPersonaUsable(revoked)).toBe(false);
  });

  it("is false when consent status is pending", () => {
    process.env[base.voice.voiceIdEnv] = "some-voice-id";
    const pending = {
      ...base,
      voice: { ...base.voice, consent: { ...base.voice.consent, status: "pending" as const } },
    };
    expect(isPersonaUsable(pending)).toBe(false);
  });

  it("is true when voice id is set and consent is granted with no revocation", () => {
    process.env[base.voice.voiceIdEnv] = "some-voice-id";
    const granted = {
      ...base,
      voice: { ...base.voice, consent: { ...base.voice.consent, status: "granted" as const, revokedAt: undefined } },
    };
    expect(isPersonaUsable(granted)).toBe(true);
  });
});
