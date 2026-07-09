-- ============================================================================
-- ONE-TIME: Renita Knight left a 5-star Google review — stop Joey's review-call
-- queue from including her job(s), and record the review itself.
-- ----------------------------------------------------------------------------
-- No code depends on her name specifically — this just sets the same
-- 'reviewed' status a phone call would log (migration 0049), and inserts one
-- row into google_reviews (migration 0042), same as the automated Gmail
-- ingester would once it's wired up (see mark-renita-knight-reviewed note below).
-- ============================================================================
set search_path = app, public, extensions;

-- 1) Drop her completed job(s) out of the review-call queue. The customer's
--    name lives on `customers`, not `bookings` (bookings.customer_id -> customers.id).
update bookings b
set review_call_status = 'reviewed',
    review_call_at = now(),
    review_call_by = 'Owner (confirmed Google review)'
from customers c
where b.customer_id = c.id
  and c.name ilike 'renita knight%'
  and b.status = 'completed';

-- 2) Record the actual review (credited to her job's lead technician),
--    limited to her most recent completed job so she isn't double-counted
--    if she has more than one booking on file.
insert into google_reviews (business_id, reviewer_name, rating, review_text, review_date, google_key, booking_id, technician_id, seen)
select
  b.business_id,
  'Renita Knight',
  5,
  null,
  current_date,
  'manual-renita-knight-' || b.id,
  b.id,
  b.technician_id,
  false
from bookings b
join customers c on c.id = b.customer_id
where c.name ilike 'renita knight%'
  and b.status = 'completed'
order by b.completed_at desc
limit 1
on conflict (business_id, google_key) do nothing;

-- Verify:
--   select c.name, b.review_call_status, b.review_call_by
--   from bookings b join customers c on c.id = b.customer_id
--   where c.name ilike 'renita knight%';
--
--   select reviewer_name, rating, review_date, technician_id
--   from google_reviews where reviewer_name ilike 'renita knight%';
--
-- NOTE: once denverinstallpros@gmail.com's real review email is scanned by the
-- automated ingester (task 1 above), if that email is still sitting in the
-- inbox it may create a SECOND row for the same review (different google_key).
-- Harmless duplicate if it happens — just delete the extra row; flagging now
-- so it doesn't look like a bug later.
-- ============================================================================
