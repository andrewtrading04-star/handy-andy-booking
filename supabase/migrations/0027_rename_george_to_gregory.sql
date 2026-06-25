-- ============================================================================
-- Migration 0027: Rename Doms technician George → Gregory
-- ----------------------------------------------------------------------------
-- The Doms technician was seeded as "George" but his name is actually Gregory.
-- The seed migrations (0001, 0023, 0025) were corrected in code, but those
-- already ran against the live database with a `where not exists` guard, so the
-- existing row still reads "George". This migration renames the existing
-- technician in place so the live dashboard / tech app show the correct name.
--
-- Run after 0026. Idempotent — safe to run more than once.
-- ============================================================================
set search_path = app, public, extensions;

-- Only the Doms business ever had a technician named "George", so a plain
-- name match is sufficient and avoids a join. Fully schema-qualified so it
-- runs correctly from the Supabase SQL Editor regardless of search_path.
update app.technicians
   set name = 'Gregory'
 where name ilike 'george%';

-- ============================================================================
-- DONE. Verify with:
--   select t.name, b.slug from app.technicians t
--     join app.businesses b on b.id = t.business_id
--    where b.slug = 'doms' order by t.name;
-- Expect "Gregory" in the list, no "George".
-- ============================================================================
