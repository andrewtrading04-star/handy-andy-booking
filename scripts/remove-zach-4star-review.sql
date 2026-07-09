-- ============================================================================
-- ONE-TIME: remove Zach's mistaken 4-star Google review, and nothing else.
-- ----------------------------------------------------------------------------
-- Two places hold review data for a tech:
--   google_reviews.rating       the actual ingested Google review (shown in
--                                the Reviews tab / "just got a review" banner)
--   bookings.review_rating      the customer's rating from the internal
--                                review-request flow, on whichever job this
--                                specific review was tied to -- THIS is what
--                                feeds the average_rating star badge shown
--                                next to Zach's name in the Technicians tab.
--
-- Deletes the google_reviews row, then -- scoped ONLY to the exact booking
-- that row was linked to (via a single atomic statement, not a broad
-- "any of Zach's 4-star jobs" match) -- clears review_rating on that one
-- booking if it's also a 4. No other booking, tech, or review is touched.
-- ============================================================================
set search_path = app, public, extensions;

-- Verify first (see exactly what this will remove):
--   select gr.id, gr.reviewer_name, gr.rating, gr.review_date, gr.booking_id
--   from google_reviews gr
--   join technicians t on t.id = gr.technician_id
--   where t.name ilike 'zach%' and gr.rating = 4;

with removed as (
  delete from google_reviews gr
  using technicians t
  where gr.technician_id = t.id
    and t.name ilike 'zach%'
    and gr.rating = 4
  returning gr.booking_id
)
update bookings b
set review_rating = null
from removed
where b.id = removed.booking_id
  and b.review_rating = 4;

-- Verify after:
--   select gr.id from google_reviews gr join technicians t on t.id=gr.technician_id
--   where t.name ilike 'zach%' and gr.rating = 4;   -- should return 0 rows
-- ============================================================================
