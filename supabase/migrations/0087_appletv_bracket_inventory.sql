-- ============================================================================
-- Apple TV bracket inventory: a third trackable item on bracket_inventory,
-- following the exact pattern wire-concealment plates used (migration 0039):
-- one running-counter column on the existing per-tech row, plus a usage-log
-- column for the audit trail when a job consumes one. Unlike plates, there is
-- no email-driven purchase pipeline for this item (Amazon's order-confirmation
-- emails for it carry no distinguishing product text, so auto-detection isn't
-- reliable without a dedicated mailbox the owner doesn't want to set up) --
-- arrivals are logged by hand through the existing bracket_update action, so
-- no purchases/orders table is needed, just a lightweight arrival log for
-- history.
-- ============================================================================

alter table app.bracket_inventory
  add column if not exists appletv_bracket_qty integer not null default 0;

alter table app.bracket_usage_logs
  add column if not exists appletv_bracket_used integer;

-- One row per manual "N brackets arrived for this tech" entry, for a history
-- view later even though nothing surfaces it yet. Never touched by usage
-- (deduction) -- that goes to bracket_usage_logs like every other tracked item.
create table if not exists app.appletv_bracket_log (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references app.businesses(id),
  technician_id uuid not null references app.technicians(id),
  qty           integer not null check (qty > 0),
  added_by      text,
  notes         text,
  created_at    timestamptz not null default now()
);

create index if not exists appletv_bracket_log_tech_idx
  on app.appletv_bracket_log (technician_id, created_at desc);
