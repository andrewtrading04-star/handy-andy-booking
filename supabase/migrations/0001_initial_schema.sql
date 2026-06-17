-- ============================================================================
-- Handy Andy / Doms — Business Management System
-- Migration 0001: Initial schema (multi-business, Zenbooker-import ready)
-- ----------------------------------------------------------------------------
-- HOW TO USE: paste this whole file into the Supabase SQL Editor and run it.
-- It is safe to run once on a fresh project. Re-running is mostly idempotent
-- (tables use IF NOT EXISTS; seed rows use ON CONFLICT DO NOTHING).
--
-- DESIGN PRINCIPLES
--   * Two businesses (Handy Andy, Doms) live in ONE database but are fully
--     siloed by `business_id`. Every business-owned table carries business_id.
--   * The public booking widgets already exist and write jobs to Zenbooker.
--     This schema is the destination we will migrate Zenbooker data INTO and,
--     later, the system of record the widgets write to directly.
--   * Pricing mirrors the widget's configurable model: a SERVICE has OPTION
--     GROUPS (size, bracket, fireplace, wall, wires, ...) and each group has
--     priced OPTIONS. Every option keeps its Zenbooker option id so historical
--     jobs import cleanly. A booking's chosen options are frozen onto it as
--     line items (price-at-time-of-booking).
--   * SECURITY: the Supabase ANON key ships inside the public widgets, so it
--     must never be able to read customer/booking data. RLS is ON for every
--     table below with NO anon policies = anon is denied. The admin dashboard
--     and technician app talk to the DB through Vercel serverless functions
--     using the SUPABASE_SERVICE_ROLE_KEY (which bypasses RLS). Keep that key
--     server-side only.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid(), crypt(), gen_salt()

-- ----------------------------------------------------------------------------
-- Dedicated schema so these tables NEVER collide with the existing analytics
-- tables in `public` (events, bookings, page_metrics, …). Everything below is
-- created in `app`. The app's API uses a Supabase client pinned to this schema.
-- ----------------------------------------------------------------------------
create schema if not exists app;
set search_path = app, public, extensions;
-- Don't validate function bodies at CREATE time. crypt()/gen_salt() (pgcrypto,
-- installed in the `extensions` schema on Supabase) are resolved at call time
-- via each function's own search_path. Avoids a false "crypt does not exist".
set check_function_bodies = off;

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
do $$ begin
  create type staff_role as enum ('owner', 'manager', 'secretary');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Lifecycle of a job. Tech app drives on_the_way -> arrived -> completed.
  create type booking_status as enum (
    'pending',       -- created, not yet confirmed by office
    'confirmed',     -- office confirmed, not yet assigned
    'assigned',      -- a technician is assigned
    'on_the_way',    -- tech tapped "On My Way"
    'arrived',       -- tech tapped "Arrived"
    'in_progress',   -- work underway
    'completed',     -- tech tapped "Job Complete"
    'cancelled',
    'no_show'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type technician_status as enum ('available', 'on_job', 'off');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_source as enum ('widget', 'manual', 'phone', 'import', 'asurion');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('unpaid', 'card_on_file', 'deposit_paid', 'paid', 'refunded', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type line_item_kind as enum ('service', 'option', 'addon', 'coupon', 'tip', 'fee', 'custom');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Shared updated_at trigger
-- ----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end; $$ language plpgsql;

-- ============================================================================
-- businesses
-- ============================================================================
create table if not exists businesses (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,          -- 'handy-andy', 'doms' — matches events.widget
  name          text not null,
  legal_name    text,
  url           text,
  support_phone text,
  support_email text,
  timezone      text not null default 'America/Denver',
  brand_navy    text default '#0A1628',
  brand_orange  text default '#FF6B35',
  settings      jsonb not null default '{}'::jsonb,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_businesses_updated on businesses;
create trigger trg_businesses_updated before update on businesses
  for each row execute function set_updated_at();

-- ============================================================================
-- staff_users — owner + secretaries/managers.
-- Phase 1 auth is a simple ENV password gate in the dashboard; this table is
-- here so the role/permission model "plugs in cleanly" when we add real auth.
-- business_id NULL == owner (sees ALL businesses).
-- ============================================================================
create table if not exists staff_users (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,  -- NULL = owner/all
  name          text not null,
  email         text unique,
  phone         text,
  role          staff_role not null default 'secretary',
  password_hash text,                                              -- bcrypt via crypt(); NULL until set
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_staff_updated on staff_users;
create trigger trg_staff_updated before update on staff_users
  for each row execute function set_updated_at();

-- ============================================================================
-- service_areas — a metro/territory a business serves (Denver, Austin, Houston)
-- ============================================================================
create table if not exists service_areas (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  name                  text not null,                 -- 'Denver', 'Austin', 'Houston'
  state                 text,
  timezone              text default 'America/Denver',
  zenbooker_territory_id text,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  unique (business_id, name)
);
create index if not exists idx_service_areas_business on service_areas(business_id);

-- service_area_zips — which zip codes fall in a service area. Powers zip
-- validation without a Zenbooker round-trip. One zip -> one area per business.
create table if not exists service_area_zips (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  service_area_id uuid not null references service_areas(id) on delete cascade,
  postal_code     text not null,
  unique (business_id, postal_code)
);
create index if not exists idx_area_zips_lookup on service_area_zips(business_id, postal_code);

-- ============================================================================
-- services — top-level bookable service (e.g., "TV Installation")
-- ============================================================================
create table if not exists services (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  name                text not null,
  description         text,
  base_price          numeric(10,2) not null default 0,
  duration_minutes    int not null default 60,
  category            text,
  active              boolean not null default true,
  sort_order          int not null default 0,
  zenbooker_service_id text,
  settings            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (business_id, name)
);
create index if not exists idx_services_business on services(business_id);
drop trigger if exists trg_services_updated on services;
create trigger trg_services_updated before update on services
  for each row execute function set_updated_at();

-- service_option_groups — a step in the widget (Size, Bracket, Fireplace, Wall
-- Surface, Wire Hiding, Lifting, Dismount, Add-ons, Terms).
create table if not exists service_option_groups (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  service_id  uuid not null references services(id) on delete cascade,
  key         text not null,                 -- 'size','bracket','fireplace','surface','wires',...
  label       text not null,
  help_text   text,
  min_select  int not null default 0,        -- 0 = optional
  max_select  int not null default 1,        -- 1 = single choice; higher/0 = multi
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (service_id, key)
);
create index if not exists idx_option_groups_service on service_option_groups(service_id);

-- service_options — one priced choice inside a group. Price here is the default
-- (Denver) price; per-territory variance lives in price_overrides as
-- { "<service_area_id or area name>": <price> }. zenbooker_option_id ties each
-- option to the widget/Zenbooker so historical jobs import cleanly.
create table if not exists service_options (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  group_id           uuid not null references service_option_groups(id) on delete cascade,
  label              text not null,
  price              numeric(10,2) not null default 0,
  duration_minutes   int not null default 0,
  zenbooker_option_id text,
  sort_order         int not null default 0,
  active             boolean not null default true,
  price_overrides    jsonb not null default '{}'::jsonb,  -- per-area price differences
  metadata           jsonb not null default '{}'::jsonb,  -- sizecat, forSize, isDrywall, etc.
  created_at         timestamptz not null default now()
);
create index if not exists idx_options_group on service_options(group_id);
create index if not exists idx_options_zbk on service_options(zenbooker_option_id);

-- ============================================================================
-- technicians — field techs. Login = phone + 4-digit PIN (hashed via crypt()).
-- ============================================================================
create table if not exists technicians (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  name                text not null,
  phone               text,
  email               text,
  pin_hash            text,                              -- bcrypt via crypt(); set in dashboard
  status              technician_status not null default 'off',
  active              boolean not null default true,
  color               text,                              -- calendar color (future)
  zenbooker_provider_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (business_id, phone)
);
create index if not exists idx_techs_business on technicians(business_id);
drop trigger if exists trg_techs_updated on technicians;
create trigger trg_techs_updated before update on technicians
  for each row execute function set_updated_at();

-- ============================================================================
-- customers
-- ============================================================================
create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references businesses(id) on delete cascade,
  name                text not null,
  first_name          text,
  last_name           text,
  phone               text,
  email               text,
  address_line1       text,
  address_line2       text,
  city                text,
  state               text,
  postal_code         text,
  lat                 numeric,
  lng                 numeric,
  notes               text,
  tags                text[] not null default '{}',
  stripe_customer_id  text,
  zenbooker_customer_id text,
  metadata            jsonb not null default '{}'::jsonb,  -- raw import payload / extras
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_customers_business        on customers(business_id);
create index if not exists idx_customers_phone           on customers(business_id, phone);
create index if not exists idx_customers_email           on customers(business_id, email);
-- de-dupe imports: a Zenbooker customer maps to exactly one row per business.
-- Non-partial so the importer's ON CONFLICT can target it; multiple NULL
-- zenbooker_customer_id rows (manual customers) are still allowed because
-- Postgres treats NULLs as distinct in a unique index.
create unique index if not exists uq_customers_zbk
  on customers(business_id, zenbooker_customer_id);
drop trigger if exists trg_customers_updated on customers;
create trigger trg_customers_updated before update on customers
  for each row execute function set_updated_at();

-- ============================================================================
-- bookings (jobs)
-- ============================================================================
create table if not exists bookings (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  customer_id           uuid not null references customers(id) on delete restrict,
  technician_id         uuid references technicians(id) on delete set null,
  service_id            uuid references services(id) on delete set null,
  service_area_id       uuid references service_areas(id) on delete set null,

  status                booking_status not null default 'pending',
  source                booking_source not null default 'widget',

  scheduled_at          timestamptz,
  scheduled_end         timestamptz,
  duration_minutes      int,

  -- money (all USD)
  subtotal              numeric(10,2) not null default 0,
  discount              numeric(10,2) not null default 0,
  tip                   numeric(10,2) not null default 0,
  price                 numeric(10,2) not null default 0,   -- grand total
  payment_status        payment_status not null default 'unpaid',
  stripe_customer_id    text,
  stripe_payment_method_id text,

  -- address snapshot at booking time (customer may move later)
  address_line1         text,
  address_line2         text,
  city                  text,
  state                 text,
  postal_code           text,
  lat                   numeric,
  lng                   numeric,

  -- notes
  notes                 text,        -- internal/office
  customer_notes        text,        -- special instructions from the customer

  -- review (imported from Zenbooker; 1-5 stars)
  review_rating         int check (review_rating between 1 and 5),
  review_text           text,
  reviewed_at           timestamptz,

  -- lifecycle timestamps
  confirmed_at          timestamptz,
  assigned_at           timestamptz,
  on_the_way_at         timestamptz,
  arrived_at            timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,

  -- Zenbooker linkage (import + reconciliation)
  zenbooker_job_id      text,
  zenbooker_job_number  text,

  metadata              jsonb not null default '{}'::jsonb,  -- raw import payload / extras

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_bookings_business_sched on bookings(business_id, scheduled_at);
create index if not exists idx_bookings_business_status on bookings(business_id, status);
create index if not exists idx_bookings_tech_sched      on bookings(technician_id, scheduled_at);
create index if not exists idx_bookings_customer        on bookings(customer_id);
-- Non-partial so the importer's ON CONFLICT can target it; NULL job ids
-- (widget/manual bookings) remain distinct and unconstrained.
create unique index if not exists uq_bookings_zbk_job
  on bookings(business_id, zenbooker_job_id);
drop trigger if exists trg_bookings_updated on bookings;
create trigger trg_bookings_updated before update on bookings
  for each row execute function set_updated_at();

-- ============================================================================
-- booking_line_items — frozen price breakdown for a booking (service + every
-- chosen option, plus coupons/tips/fees). Mirrors Zenbooker's services array.
-- ============================================================================
create table if not exists booking_line_items (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references bookings(id) on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  kind         line_item_kind not null default 'service',
  name         text not null,
  description  text,
  quantity     numeric(10,2) not null default 1,
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  taxable      boolean not null default true,
  service_id   uuid references services(id) on delete set null,
  option_id    uuid references service_options(id) on delete set null,
  zenbooker_ref text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_line_items_booking on booking_line_items(booking_id);

-- ============================================================================
-- booking_status_events — append-only audit trail of every status change.
-- Powers "real-time" status in the admin dashboard and a job history view.
-- ============================================================================
create table if not exists booking_status_events (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references bookings(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  technician_id uuid references technicians(id) on delete set null,
  status        booking_status not null,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_status_events_booking on booking_status_events(booking_id, created_at);

-- ============================================================================
-- Helper: verify a technician PIN without ever exposing the hash to the client.
-- SECURITY DEFINER so it can read pin_hash under RLS. Returns the matching
-- technician (without the hash). Call via Supabase RPC from the tech-app API.
-- ============================================================================
create or replace function verify_technician_pin(p_phone text, p_pin text)
returns table (
  id uuid, business_id uuid, name text, phone text, status technician_status
)
language sql
security definer
set search_path = app, public, extensions
as $$
  select t.id, t.business_id, t.name, t.phone, t.status
  from technicians t
  where t.phone = p_phone
    and t.active
    and t.pin_hash is not null
    and t.pin_hash = crypt(p_pin, t.pin_hash);
$$;

-- Set/replace a technician's PIN (stored hashed). Called from the admin API.
create or replace function set_technician_pin(p_id uuid, p_pin text)
returns void
language sql
security definer
set search_path = app, public, extensions
as $$
  update technicians
     set pin_hash = crypt(p_pin, gen_salt('bf')),
         updated_at = now()
   where id = p_id;
$$;

-- ============================================================================
-- Row Level Security: lock everything to server-side (service role) access.
-- No anon policies are created, so the public anon key (shipped in the widgets)
-- cannot read or write any of these tables.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'businesses','staff_users','service_areas','service_area_zips','services',
    'service_option_groups','service_options','technicians','customers',
    'bookings','booking_line_items','booking_status_events'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format('alter table %I force row level security;', t);
  end loop;
end $$;

-- ============================================================================
-- SEED DATA — the two businesses, their people, and service areas.
-- Idempotent: ON CONFLICT DO NOTHING keyed on natural unique columns.
-- Technician phones/PINs are intentionally left NULL — set them in the
-- dashboard (PIN is stored hashed). Detailed per-territory option pricing is
-- imported from the widget config; the Handy Andy "TV Installation" size tiers
-- below are seeded from public/widget.js (Denver) as the canonical starting set.
-- ============================================================================

-- Businesses ----------------------------------------------------------------
insert into businesses (slug, name, url, timezone) values
  ('handy-andy', 'Handy Andy TV Mounting', 'https://ihandyandy.com', 'America/Denver'),
  ('doms',       'Doms TV Mounting',       null,                     'America/Denver')
on conflict (slug) do nothing;

-- Staff: owner (all businesses) + one secretary per business -----------------
insert into staff_users (business_id, name, role)
select null, 'Owner', 'owner'
where not exists (select 1 from staff_users where role = 'owner');

insert into staff_users (business_id, name, role)
select b.id, 'Heather', 'secretary' from businesses b
where b.slug = 'handy-andy'
  and not exists (select 1 from staff_users s where s.name = 'Heather' and s.business_id = b.id);
insert into staff_users (business_id, name, role)
select b.id, 'Joey', 'secretary' from businesses b
where b.slug = 'doms'
  and not exists (select 1 from staff_users s where s.name = 'Joey' and s.business_id = b.id);

-- Service areas -------------------------------------------------------------
insert into service_areas (business_id, name, state, timezone, zenbooker_territory_id)
select b.id, v.name, v.state, v.tz, v.terr
from businesses b
join (values
  ('handy-andy', 'Denver',  'CO', 'America/Denver',  '1685582903241x973573877706522600'),
  ('handy-andy', 'Austin',  'TX', 'America/Chicago', '1724797832896x339501352491155460'),
  ('handy-andy', 'Houston', 'TX', 'America/Chicago', '1707514546803x280800015001583600'),
  ('doms',       'Denver',  'CO', 'America/Denver',  null)
) as v(slug, name, state, tz, terr) on v.slug = b.slug
on conflict (business_id, name) do nothing;

-- Technicians ---------------------------------------------------------------
insert into technicians (business_id, name)
select b.id, v.name
from businesses b
join (values
  ('handy-andy', 'Kregg'),
  ('handy-andy', 'Juan'),
  ('handy-andy', 'Steve'),
  ('handy-andy', 'Zach'),
  ('doms',       'TK'),
  ('doms',       'George')
) as v(slug, name) on v.slug = b.slug
where not exists (
  select 1 from technicians t where t.business_id = b.id and t.name = v.name
);

-- Services + the TV Installation size tiers (Handy Andy, Denver prices) ------
insert into services (business_id, name, description, base_price, duration_minutes, category, zenbooker_service_id)
select b.id, 'TV Installation', 'Professional TV mounting and installation', 99, 60, 'TV Mounting', null
from businesses b where b.slug in ('handy-andy', 'doms')
on conflict (business_id, name) do nothing;

-- Size option group + tiers for Handy Andy (from public/widget.js, Denver)
insert into service_option_groups (business_id, service_id, key, label, min_select, max_select, sort_order)
select s.business_id, s.id, 'size', 'TV Size', 1, 1, 1
from services s join businesses b on b.id = s.business_id
where b.slug = 'handy-andy' and s.name = 'TV Installation'
on conflict (service_id, key) do nothing;

insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order, metadata)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord,
       jsonb_build_object('sizecat', v.sizecat)
from service_option_groups g
join businesses b on b.id = g.business_id
join services s on s.id = g.service_id
join (values
  ('32" Or Less', 99::numeric,  '1685657519214x408615950244710660', 1, 'small'),
  ('33"-59"',     109::numeric, '1685657519214x406129807645840830', 2, 'small'),
  ('60"-69"',     119::numeric, '1685657519214x241977595988204900', 3, 'small'),
  ('70"-84"',     149::numeric, '1685657519214x168809705059288930', 4, 'medium'),
  ('85"-97"',     179::numeric, '1693451324278x246099356920840200', 5, 'large'),
  ('98+',         229::numeric, '1729566606709x280549383678984200', 6, 'xlarge')
) as v(label, price, zbk, ord, sizecat) on true
where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'size'
  and not exists (select 1 from service_options o where o.group_id = g.id and o.zenbooker_option_id = v.zbk);

-- ============================================================================
-- DONE. Verify with:
--   select slug, name from businesses;
--   select b.slug, t.name from technicians t join businesses b on b.id=t.business_id order by 1,2;
--   select b.slug, a.name from service_areas a join businesses b on b.id=a.business_id order by 1,2;
-- ============================================================================

-- ============================================================================
-- Grants: the serverless functions use the service_role key, which must be able
-- to read/write everything in `app` (RLS still applies to other roles).
-- ============================================================================
grant usage on schema app to anon, authenticated, service_role;
grant all on all tables in schema app to service_role;
grant all on all sequences in schema app to service_role;
grant execute on all functions in schema app to service_role;
alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant all on sequences to service_role;
alter default privileges in schema app grant execute on functions to service_role;
