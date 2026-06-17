-- ============================================================================
-- Migration 0005: Technician one-time availability exceptions
-- ----------------------------------------------------------------------------
-- The weekly schedule in technician_availability is "set it and forget it".
-- This table layers ONE-TIME, date-specific overrides on top of it so a tech
-- can take a particular day off (or pick up a slot they don't normally work)
-- without editing their permanent schedule.
--
-- Each row = "on this exact date, this fixed slot's availability is overridden":
--   is_available = false  -> NOT available that date+slot (even if recurring says yes)
--   is_available = true   -> available that date+slot (even if recurring says no)
-- A date with no rows here simply follows the recurring weekly schedule.
-- Only the same FIVE fixed slots (s1..s5) are allowed — no custom times.
-- Both the technician (tech app) and the office (admin dashboard) edit this.
-- Run after 0004. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists technician_availability_exceptions (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  technician_id  uuid not null references technicians(id) on delete cascade,
  exception_date date not null,
  slot_key       text not null check (slot_key in ('s1','s2','s3','s4','s5')),
  is_available   boolean not null,
  created_at     timestamptz not null default now(),
  unique (technician_id, exception_date, slot_key)
);
create index if not exists idx_tech_avail_exc_tech     on technician_availability_exceptions(technician_id);
create index if not exists idx_tech_avail_exc_business  on technician_availability_exceptions(business_id);
create index if not exists idx_tech_avail_exc_date      on technician_availability_exceptions(technician_id, exception_date);

-- Lock to server-side (service role) access, like every other app table.
alter table technician_availability_exceptions enable row level security;
alter table technician_availability_exceptions force row level security;

grant all on technician_availability_exceptions to service_role;
