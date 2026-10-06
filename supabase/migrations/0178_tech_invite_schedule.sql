-- ============================================================================
-- Migration 0178: scheduled tech invite texts (owner 2026-10-06)
-- ----------------------------------------------------------------------------
-- tech_invites.send_at:        text the invite at this moment (cron, 10 min).
-- tech_invites.custom_message: the owner's own wording; replaces the stock text.
-- tech_invites.nudged_at:      when the "hasn't signed up in 24h" red task was
--                              put on the owner's dashboard (once per invite).
-- Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table tech_invites add column if not exists send_at timestamptz;
alter table tech_invites add column if not exists custom_message text;
alter table tech_invites add column if not exists nudged_at timestamptz;

notify pgrst, 'reload schema';
