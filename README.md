# voice-presence

A small Next.js app for talking to an AI persona by voice. You speak, it answers aloud.

## What the code does

Each turn is three API routes chained by the browser (`components/VoiceChat.tsx`):

1. `POST /api/stt`: the browser records audio with `MediaRecorder` and sends the blob here. The route forwards it to the Deepgram REST API (`nova-2`) and returns the transcript.
2. `POST /api/chat`: sends the conversation to Claude (`claude-sonnet-4-6`, `max_tokens` 256) with the persona's system prompt and returns a short reply.
3. `POST /api/tts`: sends the reply text to the ElevenLabs text-to-speech streaming API (`eleven_turbo_v2_5`) using the persona's voice id and streams MP3 back to be played.

There is one persona, defined in `lib/personas/narsi.ts` (id `narsi`, displayed as "Abhi", a listening-first friend). Adding another means adding a file in `lib/personas/` and registering it in `lib/personas/index.ts`.

## What it does not do

This repo contains no voice-cloning code. It does not create, train, or upload voices. It plays text through a voice that already exists in your ElevenLabs account, identified by an id you supply. If that voice is a clone you made in the ElevenLabs dashboard, the output sounds like it; the cloning itself happens there, not here. Conversation history lives in browser memory only and is not persisted.

## Setup

```bash
npm install
cp .env.local.example .env.local   # or create .env.local by hand
npm run dev
```

Open http://localhost:3000.

Environment variables (in `.env.local`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | yes | Claude replies |
| `DEEPGRAM_API_KEY` | yes | speech to text |
| `ELEVENLABS_API_KEY` | yes | text to speech |
| `ELEVENLABS_NARSI_VOICE_ID` | yes | ElevenLabs voice id the persona speaks with. There is no default: `/api/tts` returns a 500 explaining this if it is unset. |

The microphone needs a secure context, so use `localhost` or HTTPS.
