-- ============================================================================
-- Migration 0029: Bracket inventory tracking
-- ============================================================================
-- Tracks Walmart bracket purchases and assigns them to technicians.
-- When a delivery arrives (detected by the email watcher), it creates a
-- bracket_purchases record. The admin dashboard shows pending deliveries
-- and lets the owner assign them to techs, which updates bracket_inventory.
--
-- Schema:
--   bracket_purchases: one row per Walmart order (received or pending)
--   bracket_inventory: current count per tech
--
-- Run after 0028.
-- ============================================================================
set search_path = app, public, extensions;

-- ── bracket_purchases: Walmart orders as parsed from email or manual entry ──
create table if not exists bracket_purchases (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  walmart_order_num text,                                  -- Walmart order number (unique per business)
  flat_qty          integer not null default 0,            -- flat brackets ordered
  tilting_qty       integer not null default 0,            -- tilting brackets ordered
  full_motion_qty   integer not null default 0,            -- full motion brackets ordered
  status            text not null default 'delivered',     -- delivered | pending_assignment
  order_date        date,
  delivered_date    date,
  assigned_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_bracket_purchases_business on bracket_purchases(business_id);
create index if not exists idx_bracket_purchases_status on bracket_purchases(status);
create unique index if not exists idx_bracket_purchases_order_num on bracket_purchases(business_id, walmart_order_num) where walmart_order_num is not null;
drop trigger if exists trg_bracket_purchases_updated on bracket_purchases;
create trigger trg_bracket_purchases_updated before update on bracket_purchases
  for each row execute function set_updated_at();

-- RLS: lock to service-role only (admin dashboard access).
alter table bracket_purchases enable row level security;
alter table bracket_purchases force row level security;
grant all on bracket_purchases to service_role;

-- ── bracket_inventory: Current count per technician ──────────────────────────
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

-- RLS: lock to service-role only (admin dashboard access).
alter table bracket_inventory enable row level security;
alter table bracket_inventory force row level security;
grant all on bracket_inventory to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select * from bracket_purchases limit 5;
--   select * from bracket_inventory limit 5;
-- ============================================================================
