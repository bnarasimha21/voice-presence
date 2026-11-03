import type { SttProvider, SttRequest, SttResult } from "../types";
import { ProviderError } from "../types";

export class DeepgramSttProvider implements SttProvider {
  async transcribe(req: SttRequest): Promise<SttResult> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) throw new ProviderError("DEEPGRAM_API_KEY not set", "stt");

    let res: Response;
    try {
      res = await fetch(
        `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(
          req.model
        )}&smart_format=true&language=en`,
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
