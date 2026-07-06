-- ============================================================================
-- Migration 0051: Add Houston zip 77001 at tier #1 ($0 / $0)
-- ----------------------------------------------------------------------------
--   Houston #1 (surcharge $0 / tech payout $0): 77001  -> handy-andy
-- Houston is Handy-Andy-only (Dom's serves Denver only).
--
-- Idempotent: ON CONFLICT (business_id, postal_code) DO UPDATE re-asserts the
-- tier in place. Run after 0050.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  ('handy-andy','Houston','77001', 0, 0)
) as v(slug, area, zip, surcharge, payout)
join businesses b on b.slug = v.slug
join service_areas sa on sa.business_id = b.id and sa.name = v.area
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      tech_payout     = excluded.tech_payout,
      service_area_id = excluded.service_area_id;

-- Verify:
--   select b.slug, sa.name as metro, z.postal_code, z.surcharge, z.tech_payout
--   from service_area_zips z
--   join businesses b on b.id = z.business_id
--   join service_areas sa on sa.id = z.service_area_id
--   where z.postal_code = '77001';
-- ============================================================================
