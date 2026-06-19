-- ============================================================================
-- Migration 0012: Populate Google review URLs for service areas
-- ----------------------------------------------------------------------------
-- The 5-star path on /review.html redirects the customer to their location's
-- Google review page (service_areas.review_url).
--
-- The seeded service_areas are ONE area per metro:
--   Handy Andy -> Denver, Austin, Houston
--   Doms       -> Denver
-- The owner provided 6 Google listings (some metros have multiple physical
-- locations). We map each EXISTING area to its primary listing below. If more
-- areas are added later (e.g. Houston #2, Denver #2), set their review_url
-- individually.
--
-- Run after 0011. Idempotent (only fills when review_url is null).
-- ============================================================================
set search_path = app, public, extensions;

-- Handy Andy — Houston (primary listing: Houston #1)
update service_areas sa set review_url = 'https://g.page/r/CdizxHwpwcE0EBM/review'
from businesses b
where sa.business_id = b.id and b.slug = 'handy-andy'
  and lower(sa.name) = 'houston' and sa.review_url is null;

-- Handy Andy — Denver (primary listing: Denver #1)
update service_areas sa set review_url = 'https://g.page/r/CLh9vwRdHQDZUt4s5?g_st=ac'
from businesses b
where sa.business_id = b.id and b.slug = 'handy-andy'
  and lower(sa.name) = 'denver' and sa.review_url is null;

-- Handy Andy — Austin
update service_areas sa set review_url = 'https://g.page/r/CYE7aX6tVMnkEBM/review'
from businesses b
where sa.business_id = b.id and b.slug = 'handy-andy'
  and lower(sa.name) = 'austin' and sa.review_url is null;

-- Doms — Denver
update service_areas sa set review_url = 'https://g.page/r/Cffr7Tp2DSNOEBM/review'
from businesses b
where sa.business_id = b.id and b.slug = 'doms'
  and lower(sa.name) = 'denver' and sa.review_url is null;

-- Spare listings for additional locations, recorded here for reference:
--   Houston #2 -> https://g.page/r/CeA7fWzbLgO8EBM/review
--   Denver  #2 -> https://g.page/r/Ccj-ZjdeLtzfEBM/review
