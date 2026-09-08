-- ============================================================================
-- Migration 0108: attribute Google reviews to a specific GBP listing
-- ----------------------------------------------------------------------------
-- google_reviews (0042) keys on business_id only, so every Handy Andy review
-- landed in one bucket regardless of which of its six listings it was left on.
-- That made "the 3 most recent reviews for the Greenway Plaza listing"
-- unanswerable — which is exactly what the websites need in order to show real
-- reviews on the page that matches the listing.
--
-- Attribution comes from two signals on the notification email, resolved by
-- resolveLocation() in scripts/lib/gmb-locations.mjs:
--   source_mailbox     which inbox it arrived in (1:1 with the listing for
--                      Denver #1, Denver #2, Austin and Dom's)
--   gbp_display_name   the business name in the subject line (the only thing
--                      that separates the two Houston listings, which share
--                      one inbox)
-- Both are stored raw alongside the resolved location so a later re-attribution
-- never has to go back to the mailbox to second-guess this migration's result.
--
-- location_key is nullable on purpose. Rows ingested before this migration have
-- no location, and an email whose signals don't identify exactly one listing is
-- stored unattributed rather than filed against the wrong one. Readers must
-- treat NULL as "unknown", never as a default listing.
--
-- Idempotent. Run after 0107.
-- ============================================================================
set search_path = app, public, extensions;

alter table google_reviews add column if not exists location_key      text;
alter table google_reviews add column if not exists location_cid      text;
alter table google_reviews add column if not exists gbp_display_name  text;
alter table google_reviews add column if not exists source_mailbox    text;

comment on column google_reviews.location_key is
  'GMB_LOCATIONS[].key in scripts/lib/gmb-locations.mjs. NULL = not attributed to a listing (pre-0108 row, or ambiguous signals) — never treat NULL as a default listing.';
comment on column google_reviews.gbp_display_name is
  'Business name exactly as the notification email subject spelled it. Kept raw: it is the only signal separating the two Houston listings.';

-- The site read path: newest text reviews for one listing.
create index if not exists idx_google_reviews_location
  on google_reviews(business_id, location_key, review_date desc);

-- ============================================================================
-- DONE. Verify with:
--   select location_key, count(*), max(review_date)
--     from app.google_reviews group by location_key order by 2 desc;
-- ============================================================================
