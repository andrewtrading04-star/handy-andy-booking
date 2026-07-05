-- ============================================================================
-- Migration 0050: Add / re-tier service-area zips (Denver, Houston, Austin)
-- ----------------------------------------------------------------------------
-- Adds the booking zips below with their travel tier (customer surcharge /
-- tech payout). Denver is served by BOTH Handy Andy and Dom's, so Denver zips
-- are added to both businesses; Houston and Austin are Handy-Andy-only.
--
--   Denver  #3  ($65  / $50):  80007, 80021               -> handy-andy + doms
--   Denver  #4  ($100 / $75):  80104, 80109               -> handy-andy + doms
--   Houston #4  ($100 / $75):  77055, 77067, 77077, 77079 -> handy-andy  (NEW #4 ring for Houston)
--   Houston #2  ($15  / $10):  77581                       -> handy-andy
--   Austin  #4  ($100 / $75):  78737                       -> handy-andy
--
-- Note: Houston previously topped out at tier #3; the four zips above create a
-- Houston #4 ($100/$75) ring.
--
-- Idempotent: ON CONFLICT (business_id, postal_code) DO UPDATE re-asserts the
-- tier in place, so a zip that already exists is simply re-tiered (not duplicated).
-- Run after 0049.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  -- Denver #3  ($65 / $50) — both businesses
  ('handy-andy','Denver','80007', 65, 50),
  ('doms',      'Denver','80007', 65, 50),
  ('handy-andy','Denver','80021', 65, 50),
  ('doms',      'Denver','80021', 65, 50),
  -- Denver #4  ($100 / $75) — both businesses
  ('handy-andy','Denver','80104',100, 75),
  ('doms',      'Denver','80104',100, 75),
  ('handy-andy','Denver','80109',100, 75),
  ('doms',      'Denver','80109',100, 75),
  -- Houston #4 ($100 / $75) — Handy Andy only
  ('handy-andy','Houston','77055',100, 75),
  ('handy-andy','Houston','77067',100, 75),
  ('handy-andy','Houston','77077',100, 75),
  ('handy-andy','Houston','77079',100, 75),
  -- Houston #2 ($15 / $10) — Handy Andy only
  ('handy-andy','Houston','77581', 15, 10),
  -- Austin #4  ($100 / $75) — Handy Andy only
  ('handy-andy','Austin', '78737',100, 75)
) as v(slug, area, zip, surcharge, payout)
join businesses b on b.slug = v.slug
join service_areas sa on sa.business_id = b.id and sa.name = v.area
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      tech_payout     = excluded.tech_payout,
      service_area_id = excluded.service_area_id;

-- Verify what landed (optional — run after the insert):
--   select b.slug, sa.name as metro, z.postal_code, z.surcharge, z.tech_payout
--   from service_area_zips z
--   join businesses b on b.id = z.business_id
--   join service_areas sa on sa.id = z.service_area_id
--   where z.postal_code in
--     ('80007','80021','80104','80109','77055','77067','77077','77079','77581','78737')
--   order by b.slug, metro, z.postal_code;
-- ============================================================================
