-- ============================================================================
-- Remove phantom $0 TV-size lines across ALL bookings ("32 Or Less" bug)
-- ----------------------------------------------------------------------------
-- Many jobs carry a stray TV-size line at $0 (e.g. "32\" Or Less", "TV Size: 32
-- Or Less", "33-59", "98+") left by old Zenbooker imports. They are phantoms —
-- the customer was never charged for that TV. They do NOT affect tech pay (the
-- payroll engine already ignores any $0 size), but they clutter the ticket/editor
-- and flag jobs "needs review". This removes them everywhere.
--
-- The match: line_total <= 0  AND  the name is a bare TV-size bracket  AND  the
-- name is NOT an answer/other line (fireplace, drywall, own bracket, dismount,
-- "my tv is…", etc.). Validated against 25 real line-item names.
--
-- RUN STEP 1 (preview + count) FIRST and eyeball it. Then run STEP 2 (delete).
-- Deleting a $0 line never changes any total. Idempotent.
-- ============================================================================

-- ── STEP 1 — PREVIEW: exactly what will be removed ───────────────────────────
select li.id, c.name as customer, li.name as line, li.quantity, li.unit_price, li.line_total
from app.booking_line_items li
join app.bookings b on b.id = li.booking_id
join app.customers c on c.id = b.customer_id
where li.line_total <= 0
  and li.name !~* 'my tv is|lift|help|larger|fireplace|dismount|bracket|surface|wire|drywall|soundbar|handyman|tv type|frame|gallery|led|shelf|apple|tax|tip|fee|minimum|hdmi|location|coupon'
  and btrim(li.name) ~* '^(tv ?size[:\s-]*)?(32"?\s*(inch(es)?)?\s*(&|and|or)?\s*(less|under|below)|under\s*32|\d{2,3}"?\s*[-–]\s*\d{2,3}"?|\d{2,3}"?\s*\+?)\s*(inch(es)?)?"?$'
order by c.name;

-- Count how widespread it is:
select count(*) as phantom_lines, count(distinct li.booking_id) as jobs_affected
from app.booking_line_items li
where li.line_total <= 0
  and li.name !~* 'my tv is|lift|help|larger|fireplace|dismount|bracket|surface|wire|drywall|soundbar|handyman|tv type|frame|gallery|led|shelf|apple|tax|tip|fee|minimum|hdmi|location|coupon'
  and btrim(li.name) ~* '^(tv ?size[:\s-]*)?(32"?\s*(inch(es)?)?\s*(&|and|or)?\s*(less|under|below)|under\s*32|\d{2,3}"?\s*[-–]\s*\d{2,3}"?|\d{2,3}"?\s*\+?)\s*(inch(es)?)?"?$';

-- ── STEP 2 — DELETE the phantoms (after you've eyeballed STEP 1) ─────────────
delete from app.booking_line_items li
where li.line_total <= 0
  and li.name !~* 'my tv is|lift|help|larger|fireplace|dismount|bracket|surface|wire|drywall|soundbar|handyman|tv type|frame|gallery|led|shelf|apple|tax|tip|fee|minimum|hdmi|location|coupon'
  and btrim(li.name) ~* '^(tv ?size[:\s-]*)?(32"?\s*(inch(es)?)?\s*(&|and|or)?\s*(less|under|below)|under\s*32|\d{2,3}"?\s*[-–]\s*\d{2,3}"?|\d{2,3}"?\s*\+?)\s*(inch(es)?)?"?$'
returning li.booking_id, li.name, li.line_total;

-- Re-run STEP 1's COUNT to confirm it returns 0.
-- ============================================================================
