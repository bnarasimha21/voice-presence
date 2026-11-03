"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Persona } from "@/lib/personas";

type Status = "idle" | "listening" | "thinking" | "speaking";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

async function readApiError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.error?.message) return String(body.error.message);
  } catch {
    // not JSON; fall through
  }
  return res.statusText || `request failed (${res.status})`;
}

export function VoiceChat({ persona }: { persona: Persona }) {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastReply, setLastReply] = useState("");
  const [errorText, setErrorText] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const orbRef = useRef<HTMLButtonElement | null>(null);

  // Web Audio plumbing for live mic-level reactivity on the orb.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  // Keep the conversation scrolled to the newest message as it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, lastReply]);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        orbRef.current?.style.setProperty(
          "--level",
          String(Math.min(1, avg * 1.9))
        );
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Audio-reactivity is a nice-to-have; never block recording on it.
    }
  }, []);

  const stopLevelMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    orbRef.current?.style.setProperty("--level", "0");
  }, []);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, []);

  // Always resolves. Every failure path sets an error caption and returns
  // the UI to "idle" (unless the user has already started listening
  // again), so the orb is never stuck disabled by a failed request.
  const speak = useCallback(async (text: string, replyToken: string) => {
    setStatus("speaking");
    setLastReply(text);
    setErrorText("");

    const toIdleUnlessListening = () =>
      setStatus((s) => (s === "listening" ? s : "idle"));

    let res: Response;
    try {
      res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replyToken }),
      });
    } catch (err) {
      setErrorText(
        `Voice failed: ${err instanceof Error ? err.message : "network error"}`
      );
      toIdleUnlessListening();
      return;
    }

    if (!res.ok) {
      setErrorText(`Voice failed: ${await readApiError(res)}`);
      toIdleUnlessListening();
      return;
    }

    try {
      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);

      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.onended = () => {
        setStatus("idle");
        URL.revokeObjectURL(url);
      };
      await audioRef.current.play();
    } catch {
      setErrorText("Audio could not play.");
      toIdleUnlessListening();
    }
  }, []);

  const sendMessage = useCallback(
    async (userText: string) => {
      if (!userText.trim()) return;

      const newMessages: ChatMessage[] = [
        ...messages,
        { role: "user", content: userText },
      ];
      setMessages(newMessages);
      setErrorText("");
      setStatus("thinking");

      let res: Response;
      try {
        res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personaId: persona.id, messages: newMessages }),
        });
      } catch (err) {
        setErrorText(
          `Could not reach the assistant: ${err instanceof Error ? err.message : "network error"}`
        );
        setStatus("idle");
        return;
      }

      if (!res.ok) {
        setErrorText(`The assistant failed: ${await readApiError(res)}`);
        setStatus("idle");
        return;
      }

      let reply: string;
      let replyToken: string;
      try {
        const body = await res.json();
        reply = body.reply;
        replyToken = body.replyToken;
        if (typeof reply !== "string" || typeof replyToken !== "string") {
          throw new Error("malformed response");
        }
      } catch {
        setErrorText("The assistant returned an unexpected response.");
        setStatus("idle");
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await speak(reply, replyToken);
    },
    [messages, persona.id, speak]
  );

  const startListening = useCallback(async () => {
    stopSpeaking(); // barge-in: cut off the persona if mid-sentence
    setErrorText("");
    chunksRef.current = [];

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErrorText(
        "Microphone access was denied. Allow microphone access and try again."
      );
      setStatus("idle");
      return;
    }

    setStatus("listening");
    startLevelMeter(stream);

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      stopLevelMeter();

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      let res: Response;
      try {
        res = await fetch("/api/stt", { method: "POST", body: blob });
      } catch (err) {
        setErrorText(
          `Could not transcribe: ${err instanceof Error ? err.message : "network error"}`
        );
        setStatus("idle");
        return;
      }

      if (!res.ok) {
        setErrorText(`Could not transcribe: ${await readApiError(res)}`);
        setStatus("idle");
        return;
      }

      let transcript: string;
      try {
        const body = await res.json();
        transcript = body.transcript ?? "";
      } catch {
        setErrorText("Transcription returned an unexpected response.");
        setStatus("idle");
        return;
      }

      if (!transcript.trim()) {
        setStatus("idle");
        return;
      }
      await sendMessage(transcript);
    };

    recorder.start();
  }, [sendMessage, stopSpeaking, startLevelMeter, stopLevelMeter]);

  const stopListening = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  const toggleMic = useCallback(() => {
    if (status === "listening") {
      stopListening();
    } else if (status === "idle" || status === "speaking") {
      startListening();
    }
  }, [status, startListening, stopListening]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      )
        return;
      e.preventDefault();
      toggleMic();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMic]);

  useEffect(() => stopLevelMeter, [stopLevelMeter]);

  const caption =
    errorText && status === "idle"
      ? errorText
      : status === "listening"
      ? "Listening…"
      : status === "thinking"
        ? "Thinking…"
        : status === "speaking"
          ? lastReply
          : messages.length === 0
            ? `This is an AI voice speaking as ${persona.name}, not a live recording. So, what's on your mind?`
            : "Tap the orb or press space";

  const hint =
    status === "listening"
      ? "tap or press space to send"
      : status === "thinking"
        ? ""
        : "tap the orb · or press space";

  return (
    <div className="orb-stage flex flex-col h-screen text-white overflow-hidden">
      {/* Issue 3: layered disclosure, visible label while the persona is on screen */}
      <div className="w-full text-center bg-amber-900/40 text-amber-200 text-xs py-1 tracking-wide">
        AI voice, not a recording of a real person speaking live
      </div>

      <header className="flex flex-col items-center gap-1 pt-6 shrink-0">
        <h1 className="text-lg font-medium tracking-wide">{persona.name}</h1>
        <p className="text-neutral-500 text-xs">{persona.tagline}</p>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center gap-10 px-6">
        <button
          ref={orbRef}
          onClick={toggleMic}
          disabled={status === "thinking"}
          data-status={status}
          aria-label={status === "listening" ? "Stop and send" : "Start talking"}
          className="orb"
          style={{ ["--level" as string]: 0 }}
        >
          <span className="orb-ring" />
          <span className="orb-ring delay" />
          <span className="orb-core" />
        </button>

        <p
          key={caption}
          className={`caption-in max-w-md text-center text-base min-h-7 px-4 ${
            errorText && status === "idle" ? "text-red-400" : "text-neutral-200"
          }`}
        >
          {caption}
        </p>
      </main>

      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="transcript shrink-0 w-full max-w-md mx-auto px-5 pt-3 pb-2 overflow-y-auto flex flex-col gap-3 max-h-[32vh]"
        >
          {messages.map((m, i) => {
            const isAssistant = m.role === "assistant";
            const isSpeakingNow =
              isAssistant && status === "speaking" && i === messages.length - 1;
            return (
              <div
                key={i}
                className={`flex items-end gap-2 ${
                  isAssistant ? "self-start" : "self-end flex-row-reverse"
                }`}
              >
                {isAssistant && <span className="msg-orb" aria-hidden />}
                <div
                  className={`bubble ${
                    isAssistant ? "bubble-abhi" : "bubble-user"
                  } ${isSpeakingNow ? "bubble-speaking" : ""}`}
                >
                  {m.content}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <footer className="shrink-0 text-center pb-8 pt-3">
        <p className="text-neutral-600 text-xs tracking-wide h-4">{hint}</p>
      </footer>
    </div>
  );
}
