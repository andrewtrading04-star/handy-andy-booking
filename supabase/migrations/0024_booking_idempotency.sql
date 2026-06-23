-- Prevent duplicate bookings from double-submits / concurrent requests.
-- The dashboard sends a per-attempt idempotency_key; a partial unique index makes
-- a second insert with the same key fail at the database level, so even two
-- simultaneous requests (which can land on different serverless instances and
-- thus bypass any in-memory guard) can never both create a booking.
alter table if exists app.bookings
add column if not exists idempotency_key text;

-- Partial unique index: only enforced for rows that carry a key, so historical /
-- imported bookings (NULL key) are unaffected and remain insertable.
create unique index if not exists uq_bookings_idempotency_key
  on app.bookings(idempotency_key)
  where idempotency_key is not null;
