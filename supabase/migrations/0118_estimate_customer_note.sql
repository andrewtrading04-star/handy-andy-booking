-- ============================================================================
-- Migration 0118: Customer-visible note on estimates
-- ----------------------------------------------------------------------------
-- estimates.notes is office-only ("Internal notes, not sent") and
-- estimates.description is only shown to the customer when a quote has NO line
-- items. customer_note is a separate, always-shown message from the office
-- (scope caveats, "we'll bring the ladder", access instructions...) rendered
-- on the approve page and in the quote email. Idempotent. Applied 2026-09-19.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates add column if not exists customer_note text;
