-- ============================================================================
-- Migration 0112: Per-channel send confirmation on estimates
-- ----------------------------------------------------------------------------
-- estimates.contacted_at/contacted_by only ever recorded the MOST RECENT send,
-- so an estimate texted at 1:17pm then also emailed at 1:20pm showed just the
-- email -- the office had no way to see, from the card, that both went out.
-- Adds separate texted_at/texted_by and emailed_at/emailed_by so each channel
-- confirms independently. contacted_at/contacted_by are left in place (still
-- used for the "Estimate sent" status transition and the isNotApproved aging
-- check) and continue to be stamped alongside these on every send.
-- Idempotent. Run after 0097.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates add column if not exists texted_at  timestamptz;
alter table estimates add column if not exists texted_by  text;
alter table estimates add column if not exists emailed_at timestamptz;
alter table estimates add column if not exists emailed_by text;

-- ============================================================================
-- DONE. Verify with:
--   select column_name from information_schema.columns
--   where table_schema='app' and table_name='estimates' and column_name like '%texted%' or column_name like '%emailed%';
-- ============================================================================
