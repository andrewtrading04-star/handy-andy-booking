-- ============================================================================
-- Migration 0103: AI voice bot v2 (ConversationRelay + OpenAI Realtime)
-- ============================================================================
-- Separate on/off switch from v1's ai_bot_enabled so the two can't collide —
-- v2 takes priority when both happen to be true on the same line (checked
-- first in handleVoiceInbound). Defaults false, so this changes nothing
-- about live call routing until explicitly flipped on one line.
-- ============================================================================
set search_path = app, public, extensions;

alter table tracking_numbers add column if not exists ai_bot_v2_enabled boolean not null default false;
