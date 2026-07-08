-- ============================================================================
-- Migration 0059: Denver-metro gap fill (owner-reviewed zip cross-check).
-- ----------------------------------------------------------------------------
-- Follows a full cross-check of every zip in the actual 6-county Denver-metro
-- service footprint (Denver, Jefferson, Adams, Arapahoe, Douglas, Broomfield,
-- Boulder counties) against what was already seeded in service_area_zips.
-- Owner reviewed the gap list and approved these specific zips/tiers — the
-- more remote/mountain zips found in the same audit (Nederland, Ward,
-- Jamestown, Evergreen-adjacent hamlets, far-eastern-plains towns, etc.) were
-- deliberately left OUT, so they still correctly answer "new area."
--
--   Denver #3  ($65  / $50):  80003 (Arvada), 80020 (Broomfield)
--   Denver #4  ($100 / $75):  80501, 80504 (Longmont), 80104 (Castle Rock —
--     already present via migration 0050, re-asserted here idempotently),
--     80516 (Erie), 80503 (Longmont), 80439 (Evergreen), 80403 (Golden),
--     80241 (Northglenn), 80026 (Lafayette), 80025 (Eldorado Springs)
--
-- Denver is served by BOTH Handy Andy and Dom's, so every zip below is added
-- to both. (80234/Northglenn was seeded live earlier the same day at Denver #3
-- -- $65/$50, matching its neighbors 80233/80260 -- and is intentionally NOT
-- touched here: it isn't part of this batch and is already correctly tiered.)
--
-- Idempotent: ON CONFLICT (business_id, postal_code) DO UPDATE re-asserts the
-- tier in place, so a zip that already exists is simply re-tiered, not duplicated.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
  -- Denver #3 ($65 / $50)
  ('handy-andy','Denver','80003',65, 50),
  ('doms',      'Denver','80003',65, 50),
  ('handy-andy','Denver','80020',65, 50),
  ('doms',      'Denver','80020',65, 50),
  -- Denver #4 ($100 / $75)
  ('handy-andy','Denver','80501',100, 75),
  ('doms',      'Denver','80501',100, 75),
  ('handy-andy','Denver','80504',100, 75),
  ('doms',      'Denver','80504',100, 75),
  ('handy-andy','Denver','80104',100, 75),
  ('doms',      'Denver','80104',100, 75),
  ('handy-andy','Denver','80516',100, 75),
  ('doms',      'Denver','80516',100, 75),
  ('handy-andy','Denver','80503',100, 75),
  ('doms',      'Denver','80503',100, 75),
  ('handy-andy','Denver','80439',100, 75),
  ('doms',      'Denver','80439',100, 75),
  ('handy-andy','Denver','80403',100, 75),
  ('doms',      'Denver','80403',100, 75),
  ('handy-andy','Denver','80241',100, 75),
  ('doms',      'Denver','80241',100, 75),
  ('handy-andy','Denver','80026',100, 75),
  ('doms',      'Denver','80026',100, 75),
  ('handy-andy','Denver','80025',100, 75),
  ('doms',      'Denver','80025',100, 75)
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
--   where z.postal_code in
--     ('80003','80020','80501','80504','80104','80516','80503','80439','80403','80241','80026','80025')
--   order by metro, z.postal_code, b.slug;
-- ============================================================================
