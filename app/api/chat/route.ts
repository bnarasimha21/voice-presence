import { NextRequest, NextResponse } from "next/server";
import { chat, type Message } from "@/lib/claude";
import { personas, type PersonaId } from "@/lib/personas";

export async function POST(req: NextRequest) {
  const { personaId, messages } = (await req.json()) as {
    personaId: PersonaId;
    messages: Message[];
  };

  const persona = personas[personaId];
  if (!persona) {
    return NextResponse.json({ error: "Unknown persona" }, { status: 400 });
  }

  const reply = await chat(persona, messages);
  return NextResponse.json({ reply });
}
