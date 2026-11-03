# voice-presence

A small Next.js app for talking to an AI persona by voice. You speak, it answers aloud.

## Architecture

Every paid service (Claude, Deepgram, ElevenLabs) is called only through a
provider interface in `lib/providers/types.ts` (`LlmProvider`, `SttProvider`,
`TtsProvider`). Routes never import a vendor SDK directly. `lib/providers/index.ts`
picks a real or fake implementation based on `VOICE_PROVIDERS`:

- `VOICE_PROVIDERS=real` (the production default): `lib/providers/real/*` calls
  the actual Anthropic, Deepgram, and ElevenLabs APIs.
- `VOICE_PROVIDERS=fake`: `lib/providers/fakes/*` are deterministic, scriptable,
  in-memory stand-ins. They refuse to construct when `NODE_ENV=production`, so a
  misconfigured deploy cannot silently serve fake replies. Tests always use these;
  no test makes a real network call.

### Routes

- `POST /api/stt`: audio in, transcript out (Deepgram).
- `POST /api/chat`: transcript in, a `{ reply, replyToken }` out (Claude). The
  `replyToken` is a short-lived, HMAC-signed token binding the exact reply text
  to the persona that generated it.
- `POST /api/tts`: takes only a `replyToken` (never free-form text), verifies
  it, and streams MP3 back. This is the fix for an open TTS endpoint: without
  the token, anyone who found the URL could make the cloned voice say anything.
- `POST /api/turn`: one streaming request for a whole turn, replacing the three
  round trips above when a client wants lower latency. Returns newline-delimited
  JSON events (`text_delta`, `audio`, `done`, `error`) as Claude streams its
  reply: each completed sentence (`lib/chunker.ts`) is sent to ElevenLabs and its
  audio streamed back immediately, instead of waiting for the full reply before
  any audio starts. `lib/timing.ts` records per-stage marks (first token, first
  sentence, first audio byte, turn done) returned in the final event and as a
  `Server-Timing` header.

`components/VoiceChat.tsx` still drives the UI via the three-route flow
(tap to talk, one request per stage). `/api/turn` is built and tested but not
yet wired into the browser UI; see "What is left" below.

### Personas and consent

`lib/personas/manifest.ts` is the single source of truth for who a persona is
(`character`), whose voice it uses (`voice.subject`), and whether that voice's
use has been consented to (`voice.consent`, with a status, who granted it,
when, what it covers, and a pointer to evidence kept outside this repo). A
persona is usable only when its voice id resolves to a non-empty value AND
consent is `"granted"` and not revoked (`isPersonaUsable`, fail-closed by
design). An unusable persona is hidden from the UI and every route rejects it
with 403.

`lib/validate.ts`'s `lookupPersona` resolves a persona id with `Object.hasOwn`,
not a naive `personas[id]` or `id in personas`, because a naive lookup lets an
id like `"constructor"` resolve to `Object` on the prototype chain and slip
past an "unknown persona" check.

`lib/personas/prompt.ts` adds AI-disclosure, no-medical/legal/financial-advice,
and crisis-response rules to every persona's prompt, plus a deterministic
backstop (`applyCrisisBackstop`) that appends a fixed resource line to any
reply following a message matching a small crisis-phrase list, regardless of
what the model said. This backstop is not a crisis detector or a substitute
for a trained classifier or a real crisis line; it is a narrow, explicit net
behind the model's own judgment.

`/api/tts` also prepends a short ID3 comment frame (`lib/id3.ts`) disclosing
that the audio is AI-generated, and sets an `X-AI-Generated-Voice: true`
response header.

### Abuse limits

`lib/limits.ts`: a token-bucket rate limit per session per route, a per-session
turn cap, and a UTC-day usage budget across LLM tokens, STT seconds, and TTS
characters that 429s all three routes once exceeded. `lib/config.ts` is the
single place every limit, model id, and timeout is read from. `middleware.ts`
gates every `/api/*` and `/talk` request behind a shared access code when
`ACCESS_CODE` is set (signed cookie, `timingSafeEqual` comparison).

None of this is horizontally scalable: it is in-memory, per-instance state,
which is fine for the single instance this app runs on. A shared store
(Redis, etc.) would slot in behind the same function signatures if this ever
runs on more than one instance.

## What it does not do

This repo contains no voice-cloning code. It does not create, train, or
upload voices. It plays text through a voice that already exists in an
ElevenLabs account, identified by an id supplied via env var. Conversation
history lives in browser memory only and is not persisted server-side.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in real values in .env.local
npm run dev
```

Open http://localhost:3000. The microphone needs a secure context, so use
`localhost` or HTTPS.

See `.env.example` for every environment variable this app reads, with a
short comment on each. `.env.local` is gitignored; `.env.example` is the only
env file committed, and it must only ever contain placeholders.

## Testing

Uses [Vitest](https://vitest.dev). Two kinds of tests, both run with
`npm test` and both run entirely offline against the fake providers (no
network, no real API key, safe for CI):

- `tests/unit/`: pure functions and small modules in isolation (the sentence
  chunker, the turn-state reducer, token request shaping, validation, limits,
  the persona manifest, the crisis backstop, ID3 framing, a secret-scan over
  tracked files, a deprecated-model-id scan).
- `tests/integration/`: the real exported Next.js route handlers
  (`app/api/chat/route.ts` etc.), called directly with `NextRequest`, against
  scripted fake providers. These exercise the actual request/response
  pipeline: validation, limits, consent checks, token verification, provider
  error handling, logging, end to end. No `next dev` server is started, and
  no HTTP socket is opened; the handler functions are called in-process.

```bash
npm test          # run once
npm run test:watch
npm run typecheck
```

`tests/e2e/` (Playwright, `npm run test:e2e`) is set up but no browser-level
tests have been written yet; see "What is left".

## Eval suite

`npm run eval` runs `evals/scenarios.ts` through the real `/api/turn` route
against scripted fake providers, reporting per-stage latency (time to first
token, first sentence, first audio byte, turn done) and an approximate cost
per turn (`evals/pricing.ts`; the per-unit prices there are placeholders, not
a billing source of truth). It exits non-zero if any scenario exceeds its
latency budget.

`npm run eval:persona` runs `evals/persona/cases.ts`. Cases that check a
deterministic guarantee (pending-consent persona blocked, prototype-pollution
persona id blocked, crisis resource line present) run for real against the
fake LLM and pass or fail automatically. Cases that depend on judging a real
model's wording (does it disclose being an AI when asked, does it decline to
give medical advice) are marked `requiresRealModel` and are skipped with an
explicit note unless run with `VOICE_PROVIDERS=real` and a real
`ANTHROPIC_API_KEY`; they are printed for human review rather than
auto-graded.

**Scope note:** this suite measures latency and cost. It does not measure
turn-taking or barge-in timing, because that needs a real browser (VAD
running on a live microphone stream, audio playback actually being
interrupted), which a Node eval script cannot exercise. The turn-taking
*logic* (the state machine in `lib/turn-state.ts`) is exhaustively unit
tested instead; its real-world latency under an actual VAD is not.

## What is left

Honestly scoped out of this pass, in order of what would matter next:

- **Browser wiring for `/api/turn`**: `VoiceChat.tsx` still uses the
  three-route flow. Switching it to the single streaming route, and playing
  audio chunks as they arrive (`AudioBufferSourceNode` scheduling or
  `MediaSource`) instead of after a full MP3 downloads, is real front-end
  audio engineering not attempted here.
- **Hands-free VAD and true barge-in in the browser**: `lib/turn-state.ts` is
  a complete, tested reducer for the state machine, but nothing in
  `components/VoiceChat.tsx` yet drives it from a real voice-activity
  detector or cancels in-flight audio playback on an interruption.
- **Playwright e2e coverage**: `@playwright/test` is installed and
  configured as an npm script, but no spec files exist yet (error-path,
  barge-in, or otherwise).
- **CI**: `.github/workflows/ci.yml` runs lint, typecheck, build, and the
  Vitest suite on every push, all against the fake providers. It does not
  yet run a Playwright job, since there are no e2e specs to run.
