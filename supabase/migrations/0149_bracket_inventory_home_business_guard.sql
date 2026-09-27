-- Migration 0149: one bracket_inventory row per tech, always under their HOME business
--
-- A tech carries ONE physical stock (brackets, wire plates, Apple TV brackets)
-- regardless of which company's job or supply order it's for, so their single
-- inventory row lives under technicians.business_id. Three times now a code
-- path looked the row up by the JOB's or ORDER's business instead, missed, and
-- inserted a second row under the other company:
--   * 2026-07-16 bracket deductions (commit 5199678)
--   * bracket_move callers (fixed in api/_lib/bracket-moves.js)
--   * 2026-09-26 wire-plate credits: Handy Andy Amazon order
--     112-1785146-4661841 assigned to Gregory (a Dom's tech) created a second,
--     zero-bracket row, so the Inventory tab showed him with no brackets.
--
-- This trigger closes the whole class in the database, whatever code is
-- deployed: an INSERT for a non-home business is folded into the tech's
-- existing home row (quantities added) and the stray insert is skipped; if the
-- tech has no row yet, the new row is simply moved to their home business.
-- Inserts that already use the home business (including bracket_move(), whose
-- only caller resolves the home business first) are untouched.

create or replace function app.bracket_inventory_home_business()
returns trigger
language plpgsql
security definer
set search_path = app, public
as $$
declare
  v_home uuid;
begin
  select business_id into v_home from technicians where id = new.technician_id;
  if v_home is null or new.business_id = v_home then
    return new;
  end if;

  update bracket_inventory set
    flat_qty            = coalesce(flat_qty, 0)            + coalesce(new.flat_qty, 0),
    tilting_qty         = coalesce(tilting_qty, 0)         + coalesce(new.tilting_qty, 0),
    full_motion_qty     = coalesce(full_motion_qty, 0)     + coalesce(new.full_motion_qty, 0),
    wire_plate_qty      = coalesce(wire_plate_qty, 0)      + coalesce(new.wire_plate_qty, 0),
    appletv_bracket_qty = coalesce(appletv_bracket_qty, 0) + coalesce(new.appletv_bracket_qty, 0),
    updated_at = now()
  where business_id = v_home and technician_id = new.technician_id;
  if found then
    return null;
  end if;

  new.business_id := v_home;
  return new;
end;
$$;

drop trigger if exists bracket_inventory_home_business on app.bracket_inventory;
create trigger bracket_inventory_home_business
  before insert on app.bracket_inventory
  for each row execute function app.bracket_inventory_home_business();

-- Hard backstop: with the trigger above no insert can add a second row, so
-- this only ever fires on a manual UPDATE of business_id or raw SQL.
create unique index if not exists bracket_inventory_one_row_per_tech
  on app.bracket_inventory (technician_id);

-- bracket_move() must resolve the home business itself too. Its only caller
-- (api/_lib/bracket-moves.js) already does, but if that lookup ever failed and
-- passed the job's business, the trigger would fold bracket_move's zero-row
-- insert into the home row and return nothing, so `returning * into v_inv`
-- would be null and the move would be recorded without touching the counter.
-- Identical to 0088 apart from the one resolution statement.
create or replace function app.bracket_move(
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
) returns app.bracket_moves
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

  select * into v_existing from bracket_moves where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  -- Stock lives on the tech's HOME business row (see top of this migration).
  p_business_id := coalesce((select business_id from technicians where id = p_technician_id), p_business_id);

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
    select * into v_row from bracket_moves where idempotency_key = p_idempotency_key;
    return v_row;
end;
$$;
