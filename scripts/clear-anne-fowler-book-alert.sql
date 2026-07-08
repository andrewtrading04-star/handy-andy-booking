-- ============================================================================
-- ONE-TIME: clear the "book this job ASAP" dashboard warning for Anne Fowler.
-- ----------------------------------------------------------------------------
-- This warning was turned on via a book_alert flag on her estimate (see
-- scripts/flag-anne-fowler-book-alert.sql) — no code was written specific to
-- her name, so removing it is just clearing that same flag. The banner
-- (estimateAlertHtml in admin.html) disappears the moment book_alert is false,
-- no deploy needed.
-- ============================================================================
set search_path = app, public, extensions;

update estimates
set book_alert = false
where customer_name ilike 'anne fowler%'
  and book_alert = true;

-- Verify (should show book_alert = false, or no rows if she has no estimate):
--   select id, customer_name, status, book_alert from estimates
--   where customer_name ilike 'anne fowler%';
-- ============================================================================
