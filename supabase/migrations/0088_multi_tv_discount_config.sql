-- ============================================================================
-- Editable multi-TV discount. Previously hardcoded identically in three
-- places (api/book.js, public/widget.js, public/admin.html's phone-in
-- booking form) with no way to change a number without a code deploy. One
-- global settings row (no business_id -- today's rule is identical for both
-- companies, and every reader falls back to these exact defaults, so shipping
-- this changes nothing for anyone until the owner actually edits a value).
--
-- Two independent discounts stack once a job reaches tv_threshold TVs:
--   1. A cut on the TRAVEL FEE. $0 fee -> zero_fee_per_tv dollars per TV.
--      A fee matching full_cut_fee exactly -> the whole fee. A fee in
--      partial_cut_fees -> partial_cut_pct of it. Any other fee -> no cut.
--   2. A flat, stepped PRICE credit for the 3rd TV onward (price_tier3 for
--      TV #3, price_tier4 for #4, price_tier5plus for every TV after that),
--      only when price_discount_enabled is true.
-- ============================================================================

create table if not exists app.multi_tv_discount_config (
  id                   uuid primary key default gen_random_uuid(),
  tv_threshold         integer not null default 3,
  zero_fee_per_tv      numeric not null default 10,
  full_cut_fee         numeric not null default 15,
  partial_cut_pct      numeric not null default 0.60,
  partial_cut_fees     numeric[] not null default '{65,100}',
  price_discount_enabled boolean not null default true,
  price_tier3          numeric not null default 20,
  price_tier4          numeric not null default 25,
  price_tier5plus      numeric not null default 30,
  updated_at           timestamptz not null default now(),
  updated_by           text
);

-- Seed the single row with today's exact hardcoded values, so the very first
-- read (before anyone edits anything) reproduces current behavior precisely.
insert into app.multi_tv_discount_config (tv_threshold, zero_fee_per_tv, full_cut_fee, partial_cut_pct, partial_cut_fees, price_discount_enabled, price_tier3, price_tier4, price_tier5plus)
select 3, 10, 15, 0.60, '{65,100}', true, 20, 25, 30
where not exists (select 1 from app.multi_tv_discount_config);
