import type { SttProvider, SttRequest, SttResult } from "../types";
import { ProviderError } from "../types";

export class DeepgramSttProvider implements SttProvider {
  async transcribe(req: SttRequest): Promise<SttResult> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new ProviderError("DEEPGRAM_API_KEY not set", "stt");

    let res: Response;
    try {
      // Finding 2 (third adversarial review): this used to hardcode
      // `language=en`. The UI is voice-only (components/VoiceChat.tsx),
      // so a Spanish or Hindi speaker in genuine crisis was transcribed
      // as garbled English text that could never match the Spanish /
      // Devanagari crisis patterns in lib/personas/prompt.ts, making
      // those patterns dead code for any real, non-English speaker.
      // `detect_language=true` tells Deepgram to auto-detect the spoken
      // language per request instead of forcing every utterance through
      // an English-only model.
      res = await fetch(
        `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(
          req.model
        )}&smart_format=true&detect_language=true`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": req.audio.type || "audio/webm",
          },
          body: req.audio,
          signal: req.signal,
        }
      );
    } catch (err) {
      throw new ProviderError(
        `Deepgram request failed: ${err instanceof Error ? err.message : String(err)}`,
        "stt"
      );
    }

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new ProviderError(`Deepgram error ${res.status}: ${err}`, "stt");
    }

    const data = await res.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    const audioSeconds: number = data?.metadata?.duration ?? 0;

    return { transcript, audioSeconds };
  }
}
