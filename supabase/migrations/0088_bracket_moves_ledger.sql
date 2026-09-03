-- ============================================================================
-- Migration 0088: bracket_moves ledger + single write entry point
-- ----------------------------------------------------------------------------
-- Fixes the structural cause of the 2026-09-03 double-deduction incident:
-- bracket_inventory was a bare mutable counter mutated by ~14 independent code
-- paths with no record of WHY it changed. A Sept-2 retroactive backfill
-- re-deducted July jobs that a Jul-7 raw-SQL reset had already absorbed,
-- because nothing recorded that the reset happened.
--
-- From here forward: bracket_moves is an append-only ledger of every signed
-- movement (flat/tilting/full_motion only — wire_plate and appletv brackets
-- are NOT yet covered, same bug class, follow-up migration). The ONLY way to
-- move the counter is bracket_move(), which is idempotent per event: calling
-- it twice with the same idempotency_key is a no-op that returns the row
-- already recorded, so a re-run backfill, a double-clicked button, or a
-- re-parsed email can never double-count again.
--
-- This migration does NOT touch bracket_inventory's current values and does
-- NOT stop old code paths from writing directly to it yet (that's the next
-- migration, once the new path is proven live). It only adds the new table,
-- function, opening-balance rows (= today's corrected counts) and a
-- drift-detection view.
-- ============================================================================
set search_path = app, public, extensions;

-- ── bracket_moves: append-only signed ledger ────────────────────────────────
create table if not exists bracket_moves (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  technician_id     uuid not null references technicians(id) on delete cascade,
  kind              text not null check (kind in ('opening','delivery','delivery_reversal','job_use','job_reversal','adjust','recount')),
  flat_delta        integer not null default 0,
  tilting_delta     integer not null default 0,
  full_motion_delta integer not null default 0,
  clamped_flat        integer not null default 0,  -- how much of a debit was cut off at zero (documented count was already too low)
  clamped_tilting     integer not null default 0,
  clamped_full_motion integer not null default 0,
  booking_id        uuid references bookings(id) on delete set null,
  purchase_id       uuid references bracket_purchases(id) on delete set null,
  order_num         text,
  idempotency_key   text not null,
  reason            text,             -- REQUIRED (enforced in bracket_move()) for adjust/recount
  actor             text,             -- who/what caused it: 'system', an office name, 'tech:<name>'
  created_at        timestamptz not null default now()
);
-- The whole point: replaying the same event is a no-op, not a double-count.
create unique index if not exists idx_bracket_moves_idempotency on bracket_moves(idempotency_key);
create index if not exists idx_bracket_moves_tech on bracket_moves(technician_id, created_at);
create index if not exists idx_bracket_moves_booking on bracket_moves(booking_id);
create index if not exists idx_bracket_moves_purchase on bracket_moves(purchase_id);

alter table bracket_moves enable row level security;
alter table bracket_moves force row level security;
grant all on bracket_moves to service_role;

-- ── bracket_move(): the ONE function allowed to change flat/tilting/full_motion ──
-- p_kind='recount': p_flat/p_tilting/p_full_motion are the ABSOLUTE physical
--   counts observed; the function computes the signed delta itself so the
--   ledger always records what actually moved, never a mystery "set to X".
-- Every other kind: p_flat/p_tilting/p_full_motion are already signed deltas
--   (positive for delivery/opening, negative for job_use, either sign for
--   adjust/reversal).
-- Idempotent: a second call with the same p_idempotency_key returns the
-- ALREADY-RECORDED row and touches nothing else — this is what makes a
-- re-run backfill, a double-submitted email, or a double-click harmless.
create or replace function bracket_move(
  p_business_id     uuid,
  p_technician_id    uuid,
  p_kind            text,
  p_flat            integer,
  p_tilting         integer,
  p_full_motion     integer,
  p_idempotency_key text,
  p_booking_id      uuid default null,
  p_purchase_id     uuid default null,
  p_order_num       text default null,
  p_reason          text default null,
  p_actor           text default null
) returns bracket_moves
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare
  v_existing   bracket_moves;
  v_inv        bracket_inventory;
  v_flat_delta integer;
  v_tilt_delta integer;
  v_fm_delta   integer;
  v_clamp_flat integer := 0;
  v_clamp_tilt integer := 0;
  v_clamp_fm   integer := 0;
  v_row        bracket_moves;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'bracket_move: idempotency_key is required';
  end if;
  if p_kind not in ('opening','delivery','delivery_reversal','job_use','job_reversal','adjust','recount') then
    raise exception 'bracket_move: invalid kind %', p_kind;
  end if;
  if p_kind in ('adjust','recount') and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'bracket_move: reason is required for kind=%', p_kind;
  end if;

  -- Idempotent replay: same event, already recorded -- return it, change nothing.
  select * into v_existing from bracket_moves where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  -- Lock (or create) the tech's row so concurrent movers serialize instead of
  -- racing a read-modify-write (the "counter lost update" finding).
  select * into v_inv from bracket_inventory
    where business_id = p_business_id and technician_id = p_technician_id
    for update;
  if not found then
    insert into bracket_inventory (business_id, technician_id, flat_qty, tilting_qty, full_motion_qty)
      values (p_business_id, p_technician_id, 0, 0, 0)
      returning * into v_inv;
  end if;

  if p_kind = 'recount' then
    v_flat_delta := coalesce(p_flat, v_inv.flat_qty)        - v_inv.flat_qty;
    v_tilt_delta := coalesce(p_tilting, v_inv.tilting_qty)  - v_inv.tilting_qty;
    v_fm_delta   := coalesce(p_full_motion, v_inv.full_motion_qty) - v_inv.full_motion_qty;
  else
    v_flat_delta := coalesce(p_flat, 0);
    v_tilt_delta := coalesce(p_tilting, 0);
    v_fm_delta   := coalesce(p_full_motion, 0);
  end if;

  -- Clamp at zero (never go negative), but record what was clamped away --
  -- that's the drift-compounding-invisibly bug (TK, 2026-08-21) closed for good.
  if v_inv.flat_qty + v_flat_delta < 0 then
    v_clamp_flat := -(v_inv.flat_qty + v_flat_delta);
    v_flat_delta := -v_inv.flat_qty;
  end if;
  if v_inv.tilting_qty + v_tilt_delta < 0 then
    v_clamp_tilt := -(v_inv.tilting_qty + v_tilt_delta);
    v_tilt_delta := -v_inv.tilting_qty;
  end if;
  if v_inv.full_motion_qty + v_fm_delta < 0 then
    v_clamp_fm := -(v_inv.full_motion_qty + v_fm_delta);
    v_fm_delta := -v_inv.full_motion_qty;
  end if;

  update bracket_inventory set
    flat_qty        = flat_qty        + v_flat_delta,
    tilting_qty     = tilting_qty     + v_tilt_delta,
    full_motion_qty = full_motion_qty + v_fm_delta,
    updated_at = now()
  where id = v_inv.id;

  insert into bracket_moves (
    business_id, technician_id, kind, flat_delta, tilting_delta, full_motion_delta,
    clamped_flat, clamped_tilting, clamped_full_motion,
    booking_id, purchase_id, order_num, idempotency_key, reason, actor
  ) values (
    p_business_id, p_technician_id, p_kind, v_flat_delta, v_tilt_delta, v_fm_delta,
    v_clamp_flat, v_clamp_tilt, v_clamp_fm,
    p_booking_id, p_purchase_id, p_order_num, p_idempotency_key, p_reason, p_actor
  ) returning * into v_row;

  return v_row;
exception
  when unique_violation then
    -- Concurrent caller won the race to insert the same idempotency_key first.
    select * into v_row from bracket_moves where idempotency_key = p_idempotency_key;
    return v_row;
end;
$$;

grant execute on function bracket_move(uuid, uuid, text, integer, integer, integer, text, uuid, uuid, text, text, text) to service_role;

-- ── Opening balances: today's corrected physical counts (2026-09-03) ───────
-- One 'opening' move per tech, using their CURRENT bracket_inventory values as
-- the delta (a no-op on the counter, since the counter already equals this).
-- This is what makes bracket_drift read 0 immediately after this migration,
-- and gives every future backfill a floor: nothing before this row can be
-- re-touched, because opening's idempotency key is unique per tech forever.
insert into bracket_moves (business_id, technician_id, kind, flat_delta, tilting_delta, full_motion_delta, idempotency_key, reason, actor)
select bi.business_id, bi.technician_id, 'opening', bi.flat_qty, bi.tilting_qty, bi.full_motion_qty,
  'opening:' || bi.technician_id::text, 'Ledger launch — opening balance = physical count as corrected 2026-09-03', 'migration-0088'
from bracket_inventory bi
on conflict (idempotency_key) do nothing;

-- ── bracket_drift: counter vs ledger-sum per tech, should always be empty ───
create or replace view bracket_drift as
select
  t.name as technician,
  bi.business_id,
  bi.technician_id,
  bi.flat_qty as counter_flat, bi.tilting_qty as counter_tilting, bi.full_motion_qty as counter_full_motion,
  coalesce(m.sum_flat, 0) as ledger_flat, coalesce(m.sum_tilting, 0) as ledger_tilting, coalesce(m.sum_full_motion, 0) as ledger_full_motion,
  (bi.flat_qty - coalesce(m.sum_flat, 0)) as drift_flat,
  (bi.tilting_qty - coalesce(m.sum_tilting, 0)) as drift_tilting,
  (bi.full_motion_qty - coalesce(m.sum_full_motion, 0)) as drift_full_motion
from bracket_inventory bi
join technicians t on t.id = bi.technician_id
left join (
  select technician_id, sum(flat_delta) as sum_flat, sum(tilting_delta) as sum_tilting, sum(full_motion_delta) as sum_full_motion
  from bracket_moves group by technician_id
) m on m.technician_id = bi.technician_id
where bi.flat_qty <> coalesce(m.sum_flat, 0)
   or bi.tilting_qty <> coalesce(m.sum_tilting, 0)
   or bi.full_motion_qty <> coalesce(m.sum_full_motion, 0);

grant select on bracket_drift to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select * from bracket_drift;                          -- should be empty
--   select * from bracket_moves order by created_at desc;  -- 6 opening rows
-- ============================================================================
