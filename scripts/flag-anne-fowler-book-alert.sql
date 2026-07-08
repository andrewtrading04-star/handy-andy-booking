-- ============================================================================
-- One-time: show the "book this job ASAP" dashboard alert for ONLY Anne Fowler.
-- ----------------------------------------------------------------------------
-- The alert now fires only for estimates flagged book_alert = true (no customer
-- name is hardcoded anywhere in the code). This adds the flag column and turns it
-- on for Anne Fowler alone, so the other approved estimates (Michael, Fisher,
-- Ryan, …) stop showing the red banner. Her alert still auto-clears when her
-- estimate is converted to a job (it archives on convert). Run once.
-- ============================================================================

alter table app.estimates
  add column if not exists book_alert boolean not null default false;

update app.estimates
  set book_alert = true
  where customer_name ilike 'anne fowler%';

-- Verify (should list only Anne Fowler):
--   select customer_name, status, book_alert from app.estimates where book_alert;
-- ============================================================================
