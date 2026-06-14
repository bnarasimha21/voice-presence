"use client";

import { useState, useRef, useCallback } from "react";
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

      // PLACEHOLDER: Replace with Deepgram STT call
      // const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      // const transcript = await transcribeWithDeepgram(blob);
      const transcript = "[PLACEHOLDER — wire up Deepgram STT here]";

      await sendMessage(transcript);
    };

    recorder.start();
  }, [sendMessage, stopSpeaking]);

  const stopListening = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const statusLabel: Record<Status, string> = {
    idle: "Tap to talk",
    listening: "Listening...",
    thinking: "...",
    speaking: "Speaking",
  };

  return (
    <div className="flex flex-col items-center gap-8 p-8 min-h-screen bg-neutral-950 text-white">
      {/* Persona header */}
      <div className="flex flex-col items-center gap-3 pt-8">
        <div className="w-20 h-20 rounded-full bg-neutral-800 overflow-hidden">
          <img
            src={persona.avatarUrl}
            alt={persona.name}
            className="w-full h-full object-cover"
            onError={(e) =>
              ((e.target as HTMLImageElement).style.display = "none")
            }
          />
        </div>
        <h1 className="text-2xl font-semibold">{persona.name}</h1>
        <p className="text-neutral-400 text-sm">{persona.tagline}</p>
      </div>

      {/* Live transcript */}
      <div className="w-full max-w-md min-h-16 text-center text-neutral-300">
        {status === "listening" && liveTranscript && (
          <p className="italic">{liveTranscript}</p>
        )}
        {status === "speaking" && lastReply && (
          <p className="text-white">{lastReply}</p>
        )}
      </div>

      {/* Mic button */}
      <button
        onMouseDown={startListening}
        onMouseUp={stopListening}
        onTouchStart={startListening}
        onTouchEnd={stopListening}
        disabled={status === "thinking"}
        className={`
          w-24 h-24 rounded-full flex items-center justify-center text-3xl
          transition-all duration-150 select-none
          ${status === "listening" ? "bg-red-500 scale-110" : "bg-white text-black"}
          ${status === "thinking" ? "opacity-40 cursor-not-allowed" : "cursor-pointer active:scale-95"}
        `}
      >
        {status === "listening" ? "●" : "🎙"}
      </button>

      <p className="text-neutral-500 text-sm">{statusLabel[status]}</p>

      {/* Conversation history (optional, can hide for a cleaner look) */}
      {messages.length > 0 && (
        <div className="w-full max-w-md space-y-3 mt-4">
          {messages.slice(-6).map((m, i) => (
            <div
              key={i}
              className={`text-sm px-4 py-2 rounded-2xl max-w-xs ${
                m.role === "user"
                  ? "bg-neutral-800 self-end ml-auto text-right"
                  : "bg-neutral-900 self-start"
              }`}
            >
              {m.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
