-- ============================================================================
-- Migration 0047: Add Denver-metro zips (tiers #3 and #4)
-- ----------------------------------------------------------------------------
-- Adds new accepted booking zips for every business that serves Denver
-- (Handy Andy + Dom's, which share the Denver tiers), with their travel fees:
--
--   Denver #4  (surcharge $100 to customer / $75 payout to tech):
--     80022, 80601
--   Denver #3  (surcharge $65  to customer / $50 payout to tech):
--     80138, 80020, 80023        (80020 was listed twice — deduped)
--
-- Tiers, per migration 0032:
--   Denver #1 0/0   #2 15/10   #3 65/50   #4 100/75
--
-- Idempotent: ON CONFLICT (business_id, postal_code) overwrites in place, so a
-- re-run just re-asserts the tier. Run after 0046.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  ('handy-andy','Denver','80022',100,75),
  ('doms',      'Denver','80022',100,75),
  ('handy-andy','Denver','80601',100,75),
  ('doms',      'Denver','80601',100,75),
  ('handy-andy','Denver','80138',65,50),
  ('doms',      'Denver','80138',65,50),
  ('handy-andy','Denver','80020',65,50),
  ('doms',      'Denver','80020',65,50),
  ('handy-andy','Denver','80023',65,50),
  ('doms',      'Denver','80023',65,50)
) as v(slug, area, zip, surcharge, payout)
join businesses b on b.slug = v.slug
join service_areas sa on sa.business_id = b.id and sa.name = v.area
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      tech_payout     = excluded.tech_payout,
      service_area_id = excluded.service_area_id;
