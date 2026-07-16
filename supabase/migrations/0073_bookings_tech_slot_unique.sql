-- Repair #7: the public-booking tech/slot assignment (pickOpenTech in
-- api/_lib/availability.js, then the insert in api/_lib/mirror.js) is a
-- read-then-write across ~6-10 sequential round trips — a 0.5-2s window
-- where two customers booking at the same moment can both pass the
-- "is this tech free" check and land on the same technician/slot, since
-- nothing at the database level actually enforced it. The existing
-- idempotency_key uniqueness only dedupes a SAME customer's retried submit,
-- not two different customers racing for the same slot.
--
-- This is the actual guarantee: a tech can hold at most one non-cancelled
-- booking at any given scheduled_at instant. The second of two racing
-- inserts now fails with a unique-violation instead of silently succeeding,
-- and api/_lib/mirror.js catches that specific violation and retries the
-- insert unassigned (technician_id null) rather than losing the booking or
-- double-booking the tech.
--
-- Known residual gap (unchanged by this migration): a "big job" that
-- reserves EXTRA slots via bookings.extra_slots (migration 0052) isn't
-- represented as its own scheduled_at row — this index only guards a tech's
-- MAIN slot per booking, not slots they're occupied for as an extra_slots
-- entry on a different booking. That race is rarer (big multi-slot jobs are
-- uncommon) and would need a separate per-slot occupancy table to close
-- fully; out of scope for this fix.
create unique index if not exists bookings_tech_slot_unique
  on app.bookings (technician_id, scheduled_at)
  where status <> 'cancelled' and technician_id is not null;
