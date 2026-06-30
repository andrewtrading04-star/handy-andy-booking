-- ============================================================================
-- Migration 0043: Photo categories (New / To Post / Posted / Records)
-- ----------------------------------------------------------------------------
-- Widens booking_photos.status from the original two groups (0026) to the four
-- the owner uses to triage job photos:
--
--   new       (default)  Just uploaded — the owner's untriaged inbox.
--   to_post              Great pics flagged for social media, not posted yet.
--   posted               Already posted to social — the keeper/repost archive.
--   records              Receipts & internal stuff — kept for records, never posts.
--
-- 'private' is kept in the allowed set so EVERY existing photo stays valid with
-- zero data migration; the admin gallery shows legacy 'private' photos in the
-- New (inbox) tab so they can be triaged. New uploads default to 'new'.
--
-- Moving a photo between categories is the same one-click action as before, just
-- with more targets. Purely a label on booking_photos; no rows move or copy.
--
-- Run after 0026. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- 1) Allow the four categories (plus legacy 'private'). Drop + recreate so a
--    re-run, or a DB still on the 0026 two-value constraint, lands cleanly.
do $$
begin
  alter table booking_photos drop constraint if exists booking_photos_status_check;
  alter table booking_photos
    add constraint booking_photos_status_check
    check (status in ('new','to_post','posted','records','private'));
exception when others then
  raise notice 'Could not (re)create booking_photos_status_check: %', sqlerrm;
end $$;

-- 2) New uploads land in the inbox. Existing rows are NOT touched (no backfill);
--    legacy 'private'/'posted' values remain valid members of the new set.
alter table booking_photos alter column status set default 'new';

-- 3) The 0026 index (business_id, status, created_at desc) already covers the
--    new values — nothing to change.

-- ============================================================================
-- DONE. Verify with:
--   select status, count(*) from booking_photos group by status;
-- ============================================================================
