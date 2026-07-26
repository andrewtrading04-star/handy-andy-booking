-- ============================================================================
-- FORENSICS + RECOVERY: Lucinda Simpson line-items wipe (Jul 2026)
-- Paste each STEP into the Supabase SQL editor (app schema) and run it.
-- STEP 1-3 are read-only and safe to run any time.
-- ============================================================================
set search_path = app, public, extensions;

-- STEP 1 — What's left of the two jobs right now, and WHEN they last changed.
-- updated_at pins the exact moment of the wipe; created_at on each surviving
-- line item shows whether it survived the wipe (old timestamp = tech-app save
-- kept it as a "hidden" line) or was re-inserted by the wiping save itself
-- (new timestamp = office dashboard save posted it as part of a near-empty list).
select b.id, c.name as customer, b.scheduled_at, b.price, b.updated_at,
       b.customer_notes, b.notes
from bookings b join customers c on c.id = b.customer_id
where c.name ilike '%lucinda%simpson%'
   or (b.scheduled_at >= '2026-07-26' and b.scheduled_at < '2026-07-27');

select li.booking_id, li.name, li.kind, li.quantity, li.unit_price,
       li.line_total, li.created_at
from booking_line_items li
join bookings b on b.id = li.booking_id
join customers c on c.id = b.customer_id
where c.name ilike '%lucinda%simpson%'
order by li.created_at;

-- STEP 2 — Internal notes on tomorrow's jobs (for the second job Heather
-- mentioned): if rows exist here, the notes are NOT gone — it's a display
-- issue. If empty, note the created_at gap.
select bn.booking_id, bn.body, bn.author, bn.created_at
from booking_notes bn
join bookings b on b.id = bn.booking_id
where b.scheduled_at >= '2026-07-26' and b.scheduled_at < '2026-07-27'
order by bn.created_at;

-- STEP 3 — The automatic snapshot trail (only populates AFTER today's fix is
-- deployed; for this incident it will be empty, but run it after any future
-- scare and the last 5 versions of the ticket are right here).
select b.id, c.name, b.metadata->'li_backups' as backups
from bookings b join customers c on c.id = b.customer_id
where c.name ilike '%lucinda%simpson%';

-- ============================================================================
-- STEP 4 — RESTORE (run ONLY after filling in the real items).
-- Get the original ticket from the booking-confirmation email:
--   • Resend dashboard (resend.com -> Emails) — search lucindasimpson44@gmail.com,
--     open the "You're booked" email; every line item + price is in it.
--   • Or ask the customer to read the receipt email back.
-- Then replace the VALUES below (one row per line item, in display order),
-- put the real booking id in :booking_id, and run. line_total = unit * qty.
-- ============================================================================
-- insert into booking_line_items
--   (booking_id, business_id, kind, name, quantity, unit_price, line_total, taxable, sort_order)
-- select b.id, b.business_id, v.kind::line_item_kind, v.name, v.qty, v.unit, v.total, true, v.ord
-- from bookings b,
--      (values
--        ('service', 'TV Size: 70"-84"',                 1, 149.00, 149.00, 0),
--        ('service', 'Wires: Hide wires behind the wall',1,  85.00,  85.00, 1),
--        ('fee',     'Tax (8.25%)',                      1,  19.31,  19.31, 2)
--      ) as v(kind, name, qty, unit, total, ord)
-- where b.id = ':booking_id';
--
-- update bookings set price = (
--   select coalesce(sum(line_total),0) from booking_line_items where booking_id = ':booking_id'
-- ) where id = ':booking_id';
