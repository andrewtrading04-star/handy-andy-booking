-- ============================================================================
-- Migration 0012: Populate review URLs for service areas
-- ============================================================================
-- Adds Google review URLs for each location. Users provided:
-- Houston #1: https://g.page/r/CdizxHwpwcE0EBM/review
-- Houston #2: https://g.page/r/CeA7fWzbLgO8EBM/review
-- Denver #2: https://g.page/r/Ccj-ZjdeLtzfEBM/review
-- Denver #1: https://g.page/r/CLh9vwRdHQDZUt4s5?g_st=ac (maps shortlink)
-- Austin: https://g.page/r/CYE7aX6tVMnkEBM/review
-- Doms Denver: https://g.page/r/Cffr7Tp2DSNOEBM/review
-- Run after 0011. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

UPDATE service_areas
SET review_url = 'https://g.page/r/CdizxHwpwcE0EBM/review'
WHERE LOWER(name) LIKE '%houston%' AND LOWER(name) LIKE '%1%' AND business_id = (SELECT id FROM businesses WHERE slug = 'handy-andy')
AND review_url IS NULL;

UPDATE service_areas
SET review_url = 'https://g.page/r/CeA7fWzbLgO8EBM/review'
WHERE LOWER(name) LIKE '%houston%' AND LOWER(name) LIKE '%2%' AND business_id = (SELECT id FROM businesses WHERE slug = 'handy-andy')
AND review_url IS NULL;

UPDATE service_areas
SET review_url = 'https://g.page/r/Ccj-ZjdeLtzfEBM/review'
WHERE LOWER(name) LIKE '%denver%' AND LOWER(name) LIKE '%2%' AND business_id = (SELECT id FROM businesses WHERE slug = 'handy-andy')
AND review_url IS NULL;

UPDATE service_areas
SET review_url = 'https://g.page/r/CLh9vwRdHQDZUt4s5?g_st=ac'
WHERE LOWER(name) LIKE '%denver%' AND LOWER(name) LIKE '%1%' AND business_id = (SELECT id FROM businesses WHERE slug = 'handy-andy')
AND review_url IS NULL;

UPDATE service_areas
SET review_url = 'https://g.page/r/CYE7aX6tVMnkEBM/review'
WHERE LOWER(name) LIKE '%austin%' AND business_id = (SELECT id FROM businesses WHERE slug = 'handy-andy')
AND review_url IS NULL;

UPDATE service_areas
SET review_url = 'https://g.page/r/Cffr7Tp2DSNOEBM/review'
WHERE business_id = (SELECT id FROM businesses WHERE slug = 'doms') AND review_url IS NULL;
