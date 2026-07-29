-- Supersedes price_adjustment_pct (migration 0082, shipped unused/at-0 and
-- left in place harmlessly): the owner wants a flat dollar amount per zip,
-- not a percentage, and wants it invisible to the customer -- no itemized
-- line explaining why. price_adjustment_pct is no longer read by any code
-- path as of this migration; kept only so the earlier column isn't dropped
-- out from under anything that might still reference it.
alter table app.service_area_zips
  add column if not exists price_adjustment_amount numeric not null default 0;
