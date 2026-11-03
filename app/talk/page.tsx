import { lookupPersona } from "@/lib/validate";
import { VoiceChat } from "@/components/VoiceChat";

export default async function TalkPage({
  searchParams,
}: {
  searchParams: Promise<{ persona?: string }>;
}) {
  const { persona: personaParam } = await searchParams;

  // `lookupPersona` uses Object.hasOwn, not `in` or a plain index lookup,
  // so a value like "constructor" cannot resolve to Object.prototype's
  // constructor and slip past this check.
  const persona = lookupPersona(personaParam) ?? lookupPersona("abhi");

  if (!persona || !persona.usable) {
    return (
      <main className="min-h-screen bg-neutral-950 text-white flex items-center justify-center p-8">
        <p className="text-neutral-400 max-w-sm text-center">
          This persona is not available right now: its voice consent is missing or
          revoked.
        </p>
      </main>
    );
  }

  return <VoiceChat persona={persona} />;
}
