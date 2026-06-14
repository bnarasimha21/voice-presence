import { personas, type PersonaId } from "@/lib/personas";
import { VoiceChat } from "@/components/VoiceChat";

export default async function TalkPage({
  searchParams,
}: {
  searchParams: Promise<{ persona?: string }>;
}) {
  const { persona: personaParam } = await searchParams;
  const personaId = (personaParam as PersonaId) in personas
    ? (personaParam as PersonaId)
    : "narsi";

  return <VoiceChat persona={personas[personaId]} />;
}
