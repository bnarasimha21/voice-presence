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

  if (!persona.voiceId) {
    return new Response(
      "ELEVENLABS_NARSI_VOICE_ID is not set. Add the ElevenLabs voice id to .env.local.",
      { status: 500 }
    );
  }

  try {
    const stream = await textToSpeechStream(text, persona.voiceId);

    return new Response(stream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    console.error("TTS failed:", err);
    return new Response("Text to speech failed. Please try again.", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
