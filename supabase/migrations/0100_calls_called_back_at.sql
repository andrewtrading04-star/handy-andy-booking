-- ============================================================================
-- Migration 0100: durable "we called back" marker on calls
-- ----------------------------------------------------------------------------
-- The streamlined call card's "Contacted" indicator means: we answered the
-- call live, OR the office called back. `status` alone can't carry the
-- second half reliably — it's a single field that gets overwritten the
-- moment the row is later marked "Done" (status -> 'resolved'), so deriving
-- Contacted from "status is currently 'called_back'" would make the badge
-- flip back OFF the instant someone closes out a call they'd already
-- returned. A callback that happened stays true forever; it needs its own
-- column, not a snapshot of one that keeps changing.
--
-- Idempotent. Run after 0099.
-- ============================================================================
set search_path = app, public, extensions;

alter table app.calls
  add column if not exists called_back_at timestamptz;
