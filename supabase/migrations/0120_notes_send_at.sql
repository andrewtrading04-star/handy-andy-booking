-- ============================================================================
-- Migration 0120: scheduled notes
-- ----------------------------------------------------------------------------
-- staff_notes.send_at / tech_notes.send_at: the moment a note should START
-- showing. NULL = show immediately (every note written before this). While
-- send_at is in the future the note is invisible to its audience and shows on
-- the owner's Notes page as "Scheduled"; show_from is set to the Denver date
-- of send_at so today / today+tomorrow windows count from the scheduled day.
-- Idempotent. Applied 2026-09-19.
-- ============================================================================
set search_path = app, public, extensions;

alter table staff_notes add column if not exists send_at timestamptz;
alter table tech_notes add column if not exists send_at timestamptz;

notify pgrst, 'reload schema';
