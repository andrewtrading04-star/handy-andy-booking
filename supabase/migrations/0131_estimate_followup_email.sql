-- ============================================================================
-- Migration 0131: Automatic 3-hour follow-up email on sent estimates
-- ----------------------------------------------------------------------------
-- Owner rule (2026-09-23): once an estimate has been sent and 3 hours pass
-- with no approval, the system emails the customer the estimate again
-- ("We finished your estimate. Did you see it?"). Email only, never a text.
-- One time per estimate. This stamp is the idempotency guard AND what the
-- card shows ("Follow-up email automatically sent · <time>"). Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates add column if not exists followup_emailed_at timestamptz;
