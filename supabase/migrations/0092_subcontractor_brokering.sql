-- ============================================================================
-- Subcontractor brokering for estimates in UNSTAFFED markets (DFW, Los
-- Angeles, Phoenix, San Antonio as of Aug 2026 -- keyed off
-- app.service_areas.unstaffed, never off a hardcoded city list, so staffing a
-- market is one flag flip and the brokering button disappears on its own).
--
-- Flow: Heather calls around, types up to THREE bids on the estimate, the
-- office picks one, and the agreed sell price is written into the estimate's
-- line_items so the EXISTING estimate_send_sms / estimate_send_email actions
-- quote it. No new customer-facing senders exist; the customer never sees the
-- subcontractor or the spread.
--
-- Ships with ZERO rows in every table below. The only way a company or a price
-- enters this system is a human typing it.
-- ============================================================================

-- The directory. Today it is written to as a side effect of Heather typing a
-- bid (so the second job in Phoenix can pick the same company from a
-- dropdown); later it gets managed directly. Not per-estimate scratch data.
create table if not exists app.subcontractors (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references app.businesses(id),
  company_name text not null,
  phone        text,
  notes        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One company per business, case-insensitively: typing "ACME Mounting" on the
-- second estimate must reuse the "Acme Mounting" row rather than fork the
-- directory into near-duplicates that no dropdown can be built from.
create unique index if not exists subcontractors_biz_name_uniq
  on app.subcontractors (business_id, lower(company_name));

-- The three bid slots on one estimate. A row per slot rather than three loose
-- columns on estimates, so bids stay queryable ("who did we lose to").
-- subcontractor_id is the directory link; company_name/phone are ALSO stored
-- flat so a bid still reads correctly if the directory row is later renamed.
create table if not exists app.estimate_broker_bids (
  id               uuid primary key default gen_random_uuid(),
  estimate_id      uuid not null references app.estimates(id) on delete cascade,
  business_id      uuid not null references app.businesses(id),
  slot             smallint not null check (slot between 1 and 3),
  subcontractor_id uuid references app.subcontractors(id),
  company_name     text,
  phone            text,
  -- What the sub quoted US. Never shown to the customer.
  sub_price        numeric check (sub_price is null or sub_price >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists estimate_broker_bids_slot_uniq
  on app.estimate_broker_bids (estimate_id, slot);
create index if not exists estimate_broker_bids_estimate_idx
  on app.estimate_broker_bids (estimate_id);

-- The booked outcome, denormalized onto the estimate so brokered-profit
-- reporting is a single scan of app.estimates with no joins.
-- broker_spread is GENERATED: sell minus sub can never drift out of sync with
-- the two numbers it is derived from, and no application code can write a
-- wrong spread. This is money, so the database owns the subtraction.
alter table app.estimates
  add column if not exists broker_subcontractor_id uuid references app.subcontractors(id),
  add column if not exists broker_company_name     text,
  add column if not exists broker_sub_price        numeric,
  add column if not exists broker_sell_price       numeric,
  -- true only when a human deliberately saved BELOW the 20 percent minimum.
  add column if not exists broker_below_min        boolean not null default false,
  add column if not exists broker_booked_at        timestamptz;

alter table app.estimates
  add column if not exists broker_spread numeric
    generated always as (broker_sell_price - broker_sub_price) stored;

-- Reporting: "show me every brokered job and what I made on it".
create index if not exists estimates_broker_booked_idx
  on app.estimates (business_id, broker_booked_at)
  where broker_booked_at is not null;
