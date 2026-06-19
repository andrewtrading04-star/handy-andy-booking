-- ============================================================================
-- Migration 0004: Technician weekly availability
-- ----------------------------------------------------------------------------
-- Technicians declare which of FIVE fixed time slots they can work on each of
-- the 7 days of the week. The slots are fixed product-wide (NO custom times):
--   s1  8:00 AM – 10:00 AM      s2  11:00 AM – 1:00 PM     s3  2:00 PM – 4:00 PM
--   s4  5:00 PM – 8:00 PM       s5  8:00 PM – 10:30 PM
-- A row here = "this tech is available that day+slot". Absent = not available.
-- Both the technician (tech app) and the office (admin dashboard) edit this.
-- Secretaries are office staff, not technicians, so they have no availability.
-- Run after 0001. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists technician_availability (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  technician_id uuid not null references technicians(id) on delete cascade,
  day_of_week   smallint not null check (day_of_week between 0 and 6),  -- 0=Sun … 6=Sat
  slot_key      text not null check (slot_key in ('s1','s2','s3','s4','s5')),
  created_at    timestamptz not null default now(),
  unique (technician_id, day_of_week, slot_key)
);
create index if not exists idx_tech_avail_tech     on technician_availability(technician_id);
create index if not exists idx_tech_avail_business  on technician_availability(business_id);

-- Lock to server-side (service role) access, like every other app table.
alter table technician_availability enable row level security;
alter table technician_availability force row level security;

-- Service role grant (explicit, in case default privileges don't apply yet).
grant all on technician_availability to service_role;
