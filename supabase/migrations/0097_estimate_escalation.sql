-- ============================================================================
-- Migration 0097: Estimate response escalation ladder
-- ----------------------------------------------------------------------------
-- Two idempotency markers for the new estimate-escalation cron
-- (api/_lib/estimate-escalation.js, action=estimate_escalation_check):
--   escalated_1h_at   -- stamped the first time the 1-hour secretary reminder
--                        goes out for this estimate.
--   escalated_2_5h_at -- stamped the first time the 2.5-hour secretary+owner
--                        escalation goes out for this estimate.
-- Both null until sent, both one-shot (never re-sent once stamped), same
-- convention as bookings.metadata.otw_nudge_sent_at / staff_late_notified_at
-- in the tech-lateness flow. Plain timestamp columns rather than metadata
-- keys since estimates has no metadata jsonb column to piggyback on.
-- Idempotent. Run after 0096.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates add column if not exists escalated_1h_at timestamptz;
alter table estimates add column if not exists escalated_2_5h_at timestamptz;
