"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { Persona } from "@/lib/personas";
import type { Message } from "@/lib/claude";

// NOTE: Deepgram browser SDK handles real-time STT via WebSocket.
// Install: npm install @deepgram/sdk
// Deepgram API key is passed from server via /api/deepgram-token (to avoid exposing in client)

type Status = "idle" | "listening" | "thinking" | "speaking";

export function VoiceChat({ persona }: { persona: Persona }) {
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [lastReply, setLastReply] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the conversation scrolled to the newest message as it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, lastReply, liveTranscript]);

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

      if (!res.ok) return;

      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);

      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      audioRef.current.onended = () => {
        setStatus("idle");
        URL.revokeObjectURL(url);
      };
      audioRef.current.play();
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
      setLiveTranscript("");
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
    // Stop any ongoing speech (barge-in)
    stopSpeaking();
    setStatus("listening");
    chunksRef.current = [];

    // TODO: Replace with Deepgram real-time WebSocket for live transcript
    // For now using MediaRecorder as a placeholder — sends on stop
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const res = await fetch("/api/stt", { method: "POST", body: blob });
      if (!res.ok) { setStatus("idle"); return; }
      const { transcript } = await res.json();
      if (!transcript?.trim()) { setStatus("idle"); return; }

      await sendMessage(transcript);
    };

    recorder.start();
  }, [sendMessage, stopSpeaking]);

  const stopListening = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
  }, []);

  // Toggle: start recording if idle/speaking, stop & send if already listening.
  // (Avoids the press-and-hold race where mouseUp fires before getUserMedia resolves.)
  const toggleMic = useCallback(() => {
    if (status === "listening") {
      stopListening();
    } else if (status === "idle" || status === "speaking") {
      startListening();
    }
  }, [status, startListening, stopListening]);

  // Spacebar: press once to enable mic, press again to send.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      // Ignore if typing in an input/textarea/contenteditable.
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      )
        return;
      e.preventDefault(); // stop the page from scrolling
      toggleMic();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleMic]);

  const statusLabel: Record<Status, string> = {
    idle: "Tap or press space to talk",
    listening: "Listening... (tap or space to send)",
    thinking: "...",
    speaking: "Speaking",
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-white">
      {/* Persona header */}
      <div className="flex flex-col items-center gap-2 pt-8 pb-4 shrink-0">
        <div className="w-16 h-16 rounded-full bg-neutral-800 overflow-hidden">
          <img
            src={persona.avatarUrl}
            alt={persona.name}
            className="w-full h-full object-cover"
            onError={(e) =>
              ((e.target as HTMLImageElement).style.display = "none")
            }
          />
        </div>
        <h1 className="text-xl font-semibold">{persona.name}</h1>
        <p className="text-neutral-400 text-sm">{persona.tagline}</p>
      </div>

      {/* Conversation history — scrollable, grows to fill, auto-scrolls to newest */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto w-full max-w-md mx-auto px-4 py-4 flex flex-col gap-3"
      >
        {messages.map((m, i) => (
          <div
            key={i}
            className={`text-sm px-4 py-2 rounded-2xl max-w-[80%] whitespace-pre-wrap ${
              m.role === "user"
                ? "bg-neutral-800 self-end text-right"
                : "bg-neutral-900 self-start"
            }`}
          >
            {m.content}
          </div>
        ))}

        {/* Live transcript / in-flight reply, shown inline at the bottom */}
        {status === "listening" && liveTranscript && (
          <p className="italic text-neutral-400 self-end text-right max-w-[80%]">
            {liveTranscript}
          </p>
        )}
      </div>

      {/* Mic controls — pinned at the bottom */}
      <div className="flex flex-col items-center gap-3 py-6 shrink-0 border-t border-neutral-900">
        <button
          onClick={toggleMic}
          disabled={status === "thinking"}
          className={`
            w-20 h-20 rounded-full flex items-center justify-center text-3xl
            transition-all duration-150 select-none
            ${status === "listening" ? "bg-red-500 scale-110" : "bg-white text-black"}
            ${status === "thinking" ? "opacity-40 cursor-not-allowed" : "cursor-pointer active:scale-95"}
          `}
        >
          {status === "listening" ? "●" : "🎙"}
        </button>
        <p className="text-neutral-500 text-sm">{statusLabel[status]}</p>
      </div>
    </div>
  );
}
