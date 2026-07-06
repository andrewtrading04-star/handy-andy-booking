-- ============================================================================
-- Jennifer Groves — remove the rogue "32" Or Less" $0 TV line + diagnose origin
-- ----------------------------------------------------------------------------
-- A phantom "32\" Or Less" size line at $0 was attached to the job alongside the
-- real "33\"-59\"" TV. Because it's $0 it doesn't change the total (subtotal/price
-- stay the same), but it makes the ticket read as a 2-TV job. This removes it and
-- shows where it came from.
-- Run STEP 1 first (read-only) to confirm the booking + see the line's origin,
-- then run STEP 2 to delete it. Tables are schema-qualified (app.) so this works
-- in the Supabase SQL editor without setting search_path.
-- ============================================================================

-- ── STEP 1 — INSPECT (read-only). Confirm the booking and how it was created. ──
-- `source` tells you the origin:  widget = our booking widget · manual = office
-- New Booking · import = pulled from Zenbooker. A non-null zenbooker_job_number
-- (or a zenbooker_ref on the line) means it came from Zenbooker.
select b.id as booking_id, b.source, b.zenbooker_job_number, b.status,
       b.subtotal, b.price, b.scheduled_at, c.name as customer
from app.bookings b
join app.customers c on c.id = b.customer_id
where c.name ilike '%jennifer%groves%'
order by b.scheduled_at desc;

-- Every line item on that booking, with origin markers (zenbooker_ref = imported
-- from Zenbooker; option_id = created from our own service-option catalog).
select li.id, li.name, li.quantity, li.unit_price, li.line_total, li.kind,
       li.zenbooker_ref, li.option_id
from app.booking_line_items li
join app.bookings b on b.id = li.booking_id
join app.customers c on c.id = b.customer_id
where c.name ilike '%jennifer%groves%'
order by b.scheduled_at desc, li.created_at;

-- ── STEP 2 — REMOVE the rogue $0 "32\" Or Less" line. ─────────────────────────
-- Tightly scoped: Jennifer Groves' booking(s), a $0 line whose name is the
-- "32 … less" size. The real "33\"-59\"" ($109) line is untouched. Totals are
-- unaffected because the rogue line is $0, so no price recompute is needed.
delete from app.booking_line_items li
using app.bookings b, app.customers c
where li.booking_id = b.id
  and b.customer_id = c.id
  and c.name ilike '%jennifer%groves%'
  and li.line_total = 0 and li.unit_price = 0
  and li.name ilike '%32%' and li.name ilike '%less%'
returning li.id, li.name, li.line_total;   -- shows exactly what was removed

-- ============================================================================
-- DONE. Re-run STEP 1's line-item query to confirm only the real TV remains.
-- ============================================================================
