-- ============================================================================
-- Migration 0058: Add Denver-metro zip 80302 (Boulder) — Denver #4 tier.
-- ----------------------------------------------------------------------------
-- The New Booking "Customer ZIP" box only auto-fills a travel fee for zips that
-- already have a row in service_area_zips (it does an EXACT zip lookup, not a
-- geographic/radius match). 80302 is Boulder, inside the Denver #4 (Boulder /
-- Colorado Springs) territory per the booking widget's own comments, but it was
-- never added to any prior zip-seed migration (0042/0045/0047/0050) — so it fell
-- through to "New area" instead of auto-filling.
--
-- Denver #4 tier, matching every other Denver #4 zip already seeded (80249,
-- 80104, 80109): $100 surcharge to the customer / $75 payout to the tech.
-- Denver is served by BOTH Handy Andy and Dom's, so it's added to both.
--
-- Idempotent: ON CONFLICT re-asserts the tier in place (safe to re-run).
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  ('handy-andy','Denver','80302',100, 75),
  ('doms',      'Denver','80302',100, 75)
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
--   where z.postal_code = '80302'
--   order by b.slug;
-- ============================================================================
