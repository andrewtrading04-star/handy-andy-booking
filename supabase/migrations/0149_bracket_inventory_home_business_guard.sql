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
