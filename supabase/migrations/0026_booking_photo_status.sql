-- ============================================================================
-- Migration 0026: Photo grouping status (Private / Posted)
-- ----------------------------------------------------------------------------
-- Every job photo now belongs to one of two groups inside the admin Photos tab:
--
--   private   (default)  Internal only — where every photo starts.
--   posted               Photos the owner has chosen to surface ("Posted").
--
-- A photo can be flipped between the two groups from the Photos gallery. This is
-- purely a grouping/label on booking_photos; no rows are moved or copied.
--
-- Run after 0025. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table booking_photos
  add column if not exists status text not null default 'private';

-- Constrain to the two allowed groups. Drop + recreate so re-runs are safe even
-- if an older/looser constraint already exists.
do $$
begin
  alter table booking_photos drop constraint if exists booking_photos_status_check;
  alter table booking_photos
    add constraint booking_photos_status_check check (status in ('private','posted'));
exception when others then
  raise notice 'Could not (re)create booking_photos_status_check: %', sqlerrm;
end $$;

-- Fast lookups when filtering a business's photos by group, newest first.
create index if not exists idx_booking_photos_status
  on booking_photos(business_id, status, created_at desc);

-- ============================================================================
-- DONE. Verify with:
--   select status, count(*) from booking_photos group by status;
-- ============================================================================
