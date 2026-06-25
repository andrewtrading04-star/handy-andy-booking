-- ============================================================================
-- Migration 0029: Bracket inventory tracking
-- ============================================================================
-- Tracks Walmart bracket purchases per technician and usage.
-- Bracket types: 'flat', 'tilting', 'full_motion'
--
-- Workflow:
--   1. Parse Walmart order emails (monitored via Gmail)
--   2. Extract tech name from delivery address, qty per bracket type
--   3. Create bracket_purchases record
--   4. Update bracket_inventory with purchased qty
--   5. When Walmart cancels: decrement inventory by canceled qty
--   6. When job completed: decrement inventory by used qty
--
-- Idempotent. Run after 0028.
-- ============================================================================
set search_path = app, public, extensions;

-- ── bracket_purchases: Walmart orders as parsed from email ────────────────────
create table if not exists bracket_purchases (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  technician_id     uuid not null references technicians(id) on delete cascade,
  walmart_order_num text,                                  -- Walmart order number
  flat_qty          integer not null default 0,            -- flat brackets
  tilting_qty       integer not null default 0,            -- tilting brackets
  full_motion_qty   integer not null default 0,            -- full motion brackets
  status            text not null default 'confirmed',     -- confirmed | canceled
  order_date        date,
  estimated_delivery date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_bracket_purchases_tech on bracket_purchases(technician_id);
create index if not exists idx_bracket_purchases_business on bracket_purchases(business_id);
drop trigger if exists trg_bracket_purchases_updated on bracket_purchases;
create trigger trg_bracket_purchases_updated before update on bracket_purchases
  for each row execute function set_updated_at();

-- RLS: lock to server-side (service role).
alter table bracket_purchases enable row level security;
alter table bracket_purchases force row level security;
grant all on bracket_purchases to service_role;

-- ── bracket_inventory: Current count per tech per type ──────────────────────
create table if not exists bracket_inventory (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  technician_id     uuid not null references technicians(id) on delete cascade,
  flat_qty          integer not null default 0,
  tilting_qty       integer not null default 0,
  full_motion_qty   integer not null default 0,
  updated_at        timestamptz not null default now(),
  unique (business_id, technician_id)
);
create index if not exists idx_bracket_inventory_tech on bracket_inventory(technician_id);
drop trigger if exists trg_bracket_inventory_updated on bracket_inventory;
create trigger trg_bracket_inventory_updated before update on bracket_inventory
  for each row execute function set_updated_at();

-- RLS: lock to server-side (service role).
alter table bracket_inventory enable row level security;
alter table bracket_inventory force row level security;
grant all on bracket_inventory to service_role;

-- ── bracket_usage_logs: Audit trail when brackets are deployed ───────────────
create table if not exists bracket_usage_logs (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  booking_id        uuid references bookings(id) on delete set null,
  technician_id     uuid not null references technicians(id) on delete cascade,
  flat_used         integer not null default 0,
  tilting_used      integer not null default 0,
  full_motion_used  integer not null default 0,
  logged_by_kind    text,                                  -- 'admin', 'technician', 'system'
  notes             text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_bracket_usage_tech on bracket_usage_logs(technician_id);
create index if not exists idx_bracket_usage_booking on bracket_usage_logs(booking_id);

-- RLS: lock to server-side (service role).
alter table bracket_usage_logs enable row level security;
alter table bracket_usage_logs force row level security;
grant all on bracket_usage_logs to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select * from bracket_purchases limit 5;
--   select * from bracket_inventory;
--   select * from bracket_usage_logs limit 5;
-- ============================================================================
