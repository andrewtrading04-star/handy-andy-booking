-- Migration 0150: atomic "deduct once" stamps on bookings.metadata
--
-- Job completion subtracts wire plates / Apple TV brackets from the tech's
-- stock, guarded by a metadata stamp (wire_plate_deducted_at, ...). The code
-- checked the stamp at the START of the request but only wrote it AFTER the
-- subtraction, so a double-tapped "Complete" (two requests ~0.7 s apart) got
-- through twice -- Gregory, two bookings, 2026-09. (Brackets are safe: the
-- bracket_moves ledger is idempotent per booking.)
--
-- claim_booking_stamp() sets metadata[p_key] = now() only if it is not set yet
-- and returns true to exactly one caller, so the subtraction runs once. It
-- merges with || instead of rewriting the whole metadata object, so it can't
-- clobber a concurrent metadata write either. release_booking_stamp() undoes a
-- claim when the subtraction itself failed, so a retry can still deduct.

create or replace function app.claim_booking_stamp(p_booking_id uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path = app, public
as $$
begin
  update bookings
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(p_key, now())
   where id = p_booking_id
     and coalesce(metadata ->> p_key, '') = '';
  return found;
end;
$$;

create or replace function app.release_booking_stamp(p_booking_id uuid, p_key text)
returns void
language sql
security definer
set search_path = app, public
as $$
  update bookings set metadata = metadata - p_key where id = p_booking_id;
$$;

revoke all on function app.claim_booking_stamp(uuid, text) from public;
revoke all on function app.release_booking_stamp(uuid, text) from public;
grant execute on function app.claim_booking_stamp(uuid, text) to service_role;
grant execute on function app.release_booking_stamp(uuid, text) to service_role;
