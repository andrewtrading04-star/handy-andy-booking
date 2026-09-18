-- ============================================================================
-- Migration 0115: Customer opened the estimate link (per channel)
-- ----------------------------------------------------------------------------
-- The office could see WHEN an estimate was texted/emailed but not whether the
-- customer ever looked at it. The approve page stamps these the first time it
-- loads: email links carry ?via=email, the texted short link carries nothing
-- and counts as text. Idempotent. Run after 0112.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates add column if not exists text_opened_at  timestamptz;
alter table estimates add column if not exists email_opened_at timestamptz;
