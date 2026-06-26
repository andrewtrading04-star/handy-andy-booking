-- ============================================================================
-- Migration 0031: Doms native service-area zips + per-zip surcharge
-- ----------------------------------------------------------------------------
-- Moves Dom's TV Mounting off Zenbooker for ZIP validation. Until now the
-- public widgets asked Zenbooker "is this zip in a territory?". Doms has NO
-- Zenbooker territory (service_areas.zenbooker_territory_id IS NULL), so the
-- CRM must answer that itself from service_area_zips. This migration:
--
--   1. Adds a `surcharge` column to service_area_zips (per-zip travel surcharge
--      in dollars). NULL/absent before; defaults to 0 so Handy Andy rows are
--      unaffected.
--   2. Seeds Dom's Denver zips in three surcharge tiers.
--
-- Idempotent: the ALTER uses IF NOT EXISTS; the seed uses ON CONFLICT ...
-- DO UPDATE so re-running with a corrected list overwrites surcharges in place.
--
-- ████████████████████████████████████████████████████████████████████████████
-- ⚠️  VERIFY THE ZIP LIST BELOW BEFORE RUNNING IN SUPABASE.  ⚠️
-- The three ranges below are the tiers confirmed in chat. They are expressed as
-- generate_series() ranges for easy editing — replace the bounds (or swap in an
-- explicit VALUES list) with Dom's REAL covered zips + surcharges if these were
-- placeholders. A wrong list means real customers get rejected, or out-of-area
-- customers get accepted. Nothing here runs automatically — you paste it into
-- the Supabase SQL Editor when the list is correct.
-- ████████████████████████████████████████████████████████████████████████████
--
-- Run after 0030.
-- ============================================================================
set search_path = app, public, extensions;

-- 1) Per-zip surcharge column (dollars). Safe for Handy Andy: default 0.
alter table service_area_zips
  add column if not exists surcharge numeric(10,2) not null default 0;

-- 2) Seed Dom's Denver zips in three tiers.
--    Tier 1: no surcharge | Tier 2: +$25 | Tier 3: +$50
with doms as (
  select id from businesses where slug = 'doms'
),
area as (
  select sa.id
  from service_areas sa
  join doms on sa.business_id = doms.id
  where sa.name = 'Denver'
)
insert into service_area_zips (business_id, service_area_id, postal_code, surcharge)
select (select id from doms),
       (select id from area),
       lpad(s.z::text, 5, '0'),
       s.surcharge
from (
  select generate_series(80202, 80253) as z, 0::numeric  as surcharge   -- Tier 1 (no surcharge)
  union all
  select generate_series(80001, 80055),       25::numeric              -- Tier 2 (+$25)
  union all
  select generate_series(80101, 80143),       50::numeric              -- Tier 3 (+$50)
) s
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      service_area_id = excluded.service_area_id;

-- ============================================================================
-- DONE. Verify with:
--   select count(*), surcharge from service_area_zips z
--     join businesses b on b.id = z.business_id
--    where b.slug = 'doms' group by surcharge order by surcharge;
--   -- expect three rows: surcharge 0, 25, 50 with the tier counts.
-- ============================================================================
