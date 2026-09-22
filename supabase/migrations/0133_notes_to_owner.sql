-- ============================================================================
-- Migration 0133: Notes system opens up -- everyone can post, everyone can
-- reach Andrew
-- ----------------------------------------------------------------------------
-- Owner rule (2026-09-23), two messages back to back:
--   1. Jiyah (call auditor) gets a Notes tab to write Andrew, Heather, or Joey.
--   2. "i want heather and joey to be able to leave heather, joey, the techs,
--      and me a note. with pictures just like i can leave them a note."
--
-- staff_notes was owner-post-only, secretary-read-only. Rather than a second
-- table for Jiyah, everyone now writes into the SAME table (and the existing
-- dashboard banner/reply/photo UI, unchanged) -- one new column is enough:
-- to_owner=true means "this one is for Andrew only", independent of
-- target_slug (which keeps meaning "Handy Andy only" / "Dom's only" / null =
-- both secretaries). Jiyah's notes ride the same table too (created_by
-- 'Jiyah', written through a narrow auditor-only action -- see api/admin.js).
-- ============================================================================
set search_path = app, public, extensions;

alter table staff_notes add column if not exists to_owner boolean not null default false;
