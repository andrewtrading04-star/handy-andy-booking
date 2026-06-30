-- ============================================================================
-- Migration 0042: Add zip 80027 (Louisville / Superior, CO — Denver metro)
-- ----------------------------------------------------------------------------
-- Adds 80027 to the accepted service-area zips in TIER 3 (surcharge $65 to the
-- customer / $50 payout to the tech), for every business that serves Denver
-- (Handy Andy + Dom's, which share the Denver tiers).
--
-- Idempotent: ON CONFLICT (business_id, postal_code) overwrites in place, so a
-- re-run just re-asserts the tier. Run after 0032.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  ('handy-andy','Denver','80027',65,50),
  ('doms','Denver','80027',65,50)
) as v(slug, area, zip, surcharge, payout)
join businesses b on b.slug = v.slug
join service_areas sa on sa.business_id = b.id and sa.name = v.area
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      tech_payout     = excluded.tech_payout,
      service_area_id = excluded.service_area_id;
