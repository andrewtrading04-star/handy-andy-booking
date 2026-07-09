-- ============================================================================
-- ONE-TIME: remove Zach's mistaken 4-star review (James Braddock, 7/9/2026),
-- and nothing else.
-- ----------------------------------------------------------------------------
-- The Reviews tab's "Sent / Opened / stars" card reads straight from the
-- bookings table (see reviewRequests() in api/admin.js) -- there is no
-- separate review_requests table, and this particular review was never
-- ingested into google_reviews either (no "Left a Google review" pill was
-- showing), so the first version of this script correctly found nothing to
-- delete there. The star rating itself is bookings.review_rating on this one
-- completed job.
--
-- Scoped tightly to customer + tech + rating so only this exact booking is
-- touched -- nothing else on it changes, no other booking/tech/review is
-- affected. reviewed_at is deliberately left alone: it's what keeps this job
-- out of the review-call queue (the customer already responded), and that
-- should stay true regardless of what rating is shown.
-- ============================================================================
set search_path = app, public, extensions;

-- Verify first (confirm this is the one row before running the update):
--   select b.id, c.name as customer_name, t.name as technician_name,
--          b.completed_at, b.review_rating, b.review_text
--   from bookings b
--   join customers c on c.id = b.customer_id
--   join technicians t on t.id = b.technician_id
--   where c.name ilike 'james braddock%' and t.name ilike 'zach%'
--     and b.review_rating = 4 and b.status = 'completed';

update bookings b
set review_rating = null,
    review_text = null
from customers c, technicians t
where b.customer_id = c.id
  and b.technician_id = t.id
  and c.name ilike 'james braddock%'
  and t.name ilike 'zach%'
  and b.review_rating = 4
  and b.status = 'completed';

-- Verify after (should return 0 rows):
--   select id from bookings b join customers c on c.id=b.customer_id
--   join technicians t on t.id=b.technician_id
--   where c.name ilike 'james braddock%' and t.name ilike 'zach%' and b.review_rating = 4;
-- ============================================================================
