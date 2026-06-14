import { NextRequest, NextResponse } from "next/server";

// Deepgram REST API — transcribes an audio blob sent from the browser.
// Browser records via MediaRecorder → sends webm blob → we transcribe → return text.
export async function POST(req: NextRequest) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY not set" }, { status: 500 });
  }

  const audioBlob = await req.blob();
  if (!audioBlob.size) {
    return NextResponse.json({ error: "Empty audio" }, { status: 400 });
  }

  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": audioBlob.type || "audio/webm",
      },
      body: audioBlob,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: `Deepgram error: ${err}` }, { status: 500 });
  }

  const data = await res.json();
  const transcript =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  return NextResponse.json({ transcript });
}
