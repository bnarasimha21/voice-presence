"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Persona } from "@/lib/personas";
import type { Message } from "@/lib/claude";

type Status = "idle" | "listening" | "thinking" | "speaking";

export function VoiceChat({ persona }: { persona: Persona }) {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [lastReply, setLastReply] = useState("");

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

  // Drive --level (0..1) on the orb from the mic's volume while listening.
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
        const avg = sum / data.length / 255; // 0..1
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

  const speak = useCallback(
    async (text: string) => {
      setStatus("speaking");
      setLastReply(text);

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, personaId: persona.id }),
      });

      if (!res.ok) {
        setStatus("idle");
        return;
      }

      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);

      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.onended = () => {
        setStatus("idle");
        URL.revokeObjectURL(url);
      };
      audioRef.current.play().catch(() => setStatus("idle"));
    },
    [persona.id]
  );

  const sendMessage = useCallback(
    async (userText: string) => {
      if (!userText.trim()) return;

      const newMessages: Message[] = [
        ...messages,
        { role: "user", content: userText },
      ];
      setMessages(newMessages);
      setStatus("thinking");

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: persona.id, messages: newMessages }),
      });

      const { reply } = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
      await speak(reply);
    },
    [messages, persona.id, speak]
  );

  const startListening = useCallback(async () => {
    stopSpeaking(); // barge-in: cut off Abhi if he's mid-sentence
    setStatus("listening");
    chunksRef.current = [];

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startLevelMeter(stream);

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      stopLevelMeter();

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const res = await fetch("/api/stt", { method: "POST", body: blob });
      if (!res.ok) {
        setStatus("idle");
        return;
      }
      const { transcript } = await res.json();
      if (!transcript?.trim()) {
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

  // Toggle: start if idle/speaking, stop & send if already listening.
  const toggleMic = useCallback(() => {
    if (status === "listening") {
      stopListening();
    } else if (status === "idle" || status === "speaking") {
      startListening();
    }
  }, [status, startListening, stopListening]);

  // Spacebar: press once to start, press again to send.
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

  // Tear down audio plumbing on unmount.
  useEffect(() => stopLevelMeter, [stopLevelMeter]);

  // The line shown softly beneath the orb, by state.
  const caption =
    status === "listening"
      ? "Listening…"
      : status === "thinking"
        ? "Thinking…"
        : status === "speaking"
          ? lastReply
          : messages.length === 0
            ? "So—what's on your mind?"
            : "Tap the orb or press space";

  const hint =
    status === "listening"
      ? "tap or press space to send"
      : status === "thinking"
        ? ""
        : "tap the orb · or press space";

  return (
    <div className="orb-stage flex flex-col h-screen text-white overflow-hidden">
      {/* Persona header */}
      <header className="flex flex-col items-center gap-1 pt-10 shrink-0">
        <h1 className="text-lg font-medium tracking-wide">{persona.name}</h1>
        <p className="text-neutral-500 text-xs">{persona.tagline}</p>
      </header>

      {/* Orb — the centerpiece and the control */}
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
          className="caption-in max-w-md text-center text-base text-neutral-200 min-h-7 px-4"
        >
          {caption}
        </p>
      </main>

      {/* Conversation transcript — distinct bubbles per speaker, scrollable */}
      {messages.length > 0 && (
        <div
          ref={scrollRef}
          className="transcript shrink-0 w-full max-w-md mx-auto px-5 pt-3 pb-2 overflow-y-auto flex flex-col gap-3 max-h-[32vh]"
        >
          {messages.map((m, i) => {
            const isAbhi = m.role === "assistant";
            const isSpeakingNow =
              isAbhi && status === "speaking" && i === messages.length - 1;
            return (
              <div
                key={i}
                className={`flex items-end gap-2 ${
                  isAbhi ? "self-start" : "self-end flex-row-reverse"
                }`}
              >
                {isAbhi && <span className="msg-orb" aria-hidden />}
                <div
                  className={`bubble ${
                    isAbhi ? "bubble-abhi" : "bubble-user"
                  } ${isSpeakingNow ? "bubble-speaking" : ""}`}
                >
                  {m.content}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Hint */}
      <footer className="shrink-0 text-center pb-8 pt-3">
        <p className="text-neutral-600 text-xs tracking-wide h-4">{hint}</p>
      </footer>
    </div>
  );
}
