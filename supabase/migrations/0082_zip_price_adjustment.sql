-- Per-zip percentage price adjustment, layered on top of the existing base
-- pricing without changing it. 0 (the default, applied to every existing row
-- by this migration) is a true no-op: the booking flow skips the line item
-- entirely at 0%, so no zip's price changes until this is explicitly set.
-- Applies only to the priced service lines (TV size/brackets/add-ons/handyman
-- hours) -- never compounds on top of tax, tip, the travel surcharge, or a
-- coupon. Positive = price increase, negative = price decrease.
alter table app.service_area_zips
  add column if not exists price_adjustment_pct numeric not null default 0;

update app.service_area_zips set price_adjustment_pct = 0 where price_adjustment_pct is null;
