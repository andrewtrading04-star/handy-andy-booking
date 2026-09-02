-- ============================================================================
-- Migration 0102: AI voice bot pilot
-- ============================================================================
-- Adds the per-line on/off switch and the session-state table the voice bot
-- (api/analytics.js: voice_bot_start / voice_bot_turn) needs. Purely additive:
-- ai_bot_enabled defaults false on every existing row, so nothing about
-- current call routing changes until a specific tracking number is flipped on.
-- ============================================================================
set search_path = app, public, extensions;

alter table tracking_numbers add column if not exists ai_bot_enabled boolean not null default false;

-- One row per live call the bot is (or was) walking through the booking
-- flow, keyed by Twilio CallSid — the only thing every webhook hit for that
-- call carries, and the only reliable way to resume state across the
-- stateless serverless turns. `data` holds every answer collected so far
-- (category, zip, catalog snapshot, chosen options, schedule, customer info,
-- computed pricing) as one JSON blob rather than a wide column set, since the
-- shape is still actively changing during the pilot.
create table if not exists voice_bot_sessions (
  call_sid       text primary key,
  business_id    uuid not null references businesses(id) on delete cascade,
  business_slug  text not null,
  tracking_number text,
  caller_phone   text,
  step           text not null default 'category',
  data           jsonb not null default '{}'::jsonb,
  retry_count    integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists voice_bot_sessions_business_idx on voice_bot_sessions(business_id);
create index if not exists voice_bot_sessions_created_idx on voice_bot_sessions(created_at);
