import type { TtsProvider, TtsRequest, TtsResult } from "../types";
import { ProviderError } from "../types";

export class ElevenLabsTtsProvider implements TtsProvider {
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new ProviderError("ELEVENLABS_API_KEY not set", "tts");

    let res: Response;
    try {
      res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${req.voiceId}/stream?output_format=${encodeURIComponent(
          req.outputFormat
        )}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: req.text,
            model_id: req.model,
            apply_text_normalization: "auto",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.8,
            },
          }),
          signal: req.signal,
        }
      );
    } catch (err) {
      throw new ProviderError(
        `ElevenLabs request failed: ${err instanceof Error ? err.message : String(err)}`,
        "tts"
      );
    }

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new ProviderError(`ElevenLabs error ${res.status}: ${err}`, "tts");
    }
    if (!res.body) {
      throw new ProviderError("ElevenLabs returned no audio body", "tts");
    }

    return { stream: res.body, contentType: "audio/mpeg" };
  }
}
