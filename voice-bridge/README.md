# voice-bridge — AI Voice Bot v2

Standalone WebSocket bridge between Twilio ConversationRelay and OpenAI
(Chat Completions + function calling). **Not part of the Vercel deploy** —
Vercel serverless functions can't hold a WebSocket open for the length of a
phone call, so this needs its own always-on host.

## What it does

- Accepts the ConversationRelay WebSocket Twilio opens for each call.
- Twilio itself handles speech-to-text and text-to-speech (ElevenLabs voice,
  configured in the TwiML) — this process only ever sees/sends plain text.
- Runs the conversation through OpenAI with 6 tools (`tools.js`), each a thin
  wrapper around the CRM's real `/api/admin` actions — pricing, availability,
  and the actual booking write all happen there, never invented by the model.
- Persists a `voice_bot_sessions` row per call (same table v1 uses) so a
  booking-in-progress is at least visible if the process restarts mid-call.

## Deploy

Needs a host that keeps a Node process running (not serverless) — Fly.io,
Render, or Railway all work. Steps are the same regardless of host:

1. `cd voice-bridge && npm install`
2. Set the env vars in `.env.example` on the hosting platform (same
   `SESSION_SECRET` as the main Vercel app — tokens minted here must verify
   there).
3. Deploy so it's reachable at a stable `wss://<your-host>/relay` URL.
4. On the main app (Vercel), set `VOICE_BRIDGE_URL=wss://<your-host>` (no
   trailing slash, no `/relay` — `api/analytics.js` appends that) and
   optionally `VOICE_BRIDGE_TTS_VOICE=<an ElevenLabs voice ID>`.
5. Flip `ai_bot_v2_enabled = true` on exactly one `tracking_numbers` row to
   pilot it (same pattern as v1's `ai_bot_enabled` — leave every other line
   alone).

## Testing before a real call

Hit `GET /health` on the deployed bridge to confirm it's up. The real test is
an actual phone call to the pilot number — there's no way to simulate a
ConversationRelay session locally without Twilio's infrastructure.

## Fallback behavior

If the WebSocket never connects, or the bridge process is down, or the
session ends without an explicit transfer, Twilio's `<Connect action="...">`
falls through to `voice_bot_v2_fallback` in `api/analytics.js`, which dials
the line's normal human forward number — a caller can never get stuck with a
dead connection.
