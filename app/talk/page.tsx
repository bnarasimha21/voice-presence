import { personas } from "@/lib/personas";
import { VoiceChat } from "@/components/VoiceChat";

// For V1, default to Narsi. Later: read from URL params to switch personas.
export default function TalkPage() {
  return <VoiceChat persona={personas.narsi} />;
}
