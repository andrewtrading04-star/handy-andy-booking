-- ============================================================================
-- Migration 0040: Wire concealment plate purchases (Amazon auto-restock)
-- ============================================================================
-- Mirrors bracket_purchases, but for the Amazon-sourced wire concealment plates.
-- An Amazon order email is parsed by the bracket-tracker GitHub Action and synced
-- here (one row per active business, so either dashboard can assign it). One
-- Amazon UNIT yields 5 plates (PLATES_PER_UNIT) — the server stores both the raw
-- units and the resulting plate count. When the owner assigns a delivery to a
-- technician, that tech's bracket_inventory.wire_plate_qty increases by `plates`.
-- Run after 0039. Additive + idempotent.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists wire_plate_purchases (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  technician_id   uuid references technicians(id) on delete set null,  -- assigned tech (null = pending)
  amazon_order_num text,                                                -- Amazon order id, e.g. 123-1234567-1234567
  units           integer not null default 0,                          -- quantity ordered on Amazon
  plates          integer not null default 0,                          -- units * 5
  status          text    not null default 'in_route',                 -- in_route | delivered | canceled
  order_date      date,
  delivered_date  date,
  order_url       text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_wire_plate_purch_order on wire_plate_purchases(amazon_order_num);
create index if not exists idx_wire_plate_purch_biz   on wire_plate_purchases(business_id);

-- RLS: lock to server-side (service role) like the rest of the inventory tables.
alter table wire_plate_purchases enable row level security;
alter table wire_plate_purchases force row level security;
grant all on wire_plate_purchases to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select amazon_order_num, units, plates, status, technician_id from wire_plate_purchases;
-- ============================================================================
