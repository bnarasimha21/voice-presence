import { NextRequest } from "next/server";
import { textToSpeechStream } from "@/lib/elevenlabs";
import { personas, type PersonaId } from "@/lib/personas";

export async function POST(req: NextRequest) {
  const { text, personaId } = (await req.json()) as {
    text: string;
    personaId: PersonaId;
  };

  const persona = personas[personaId];
  if (!persona) {
    return new Response("Unknown persona", { status: 400 });
  }

  const stream = await textToSpeechStream(text, persona.voiceId);

  return new Response(stream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Transfer-Encoding": "chunked",
    },
  });
}
