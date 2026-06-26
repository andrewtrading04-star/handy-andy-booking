-- ============================================================================
-- Migration 0030: Estimate customer approval
-- ----------------------------------------------------------------------------
-- Adds `approved_at` to app.estimates so we can record when a CUSTOMER clicks
-- the "I approve" button at the bottom of a quote email. The approve link is a
-- short-lived HMAC-signed token (kind=estimate_approve, estimate_id=…) generated
-- at email-send time and verified server-side — so no public token column is
-- needed on the row itself.
--
--   approved_at IS NULL      -> not yet approved
--   approved_at IS NOT NULL  -> the customer approved this estimate at that time
--
-- The dashboard's existing status workflow (new | contacted | scheduled | closed)
-- is left untouched; approval is shown as a separate badge driven by approved_at.
-- Idempotent. Run after 0029.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates
  add column if not exists approved_at timestamptz;

-- ============================================================================
-- DONE. Verify with:
--   select id, customer_name, status, approved_at from estimates;
-- ============================================================================
