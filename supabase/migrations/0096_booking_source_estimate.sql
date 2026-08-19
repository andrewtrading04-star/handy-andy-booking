-- The estimate approve page auto-books with source='estimate', but the
-- booking_source enum never had that value -- so EVERY customer self-service
-- approval since the feature shipped failed at the booking insert (8 attempts
-- from 3 customers, Aug 6-18 2026, per Vercel runtime errors), AFTER their
-- card was already saved. The customer was told "someone will reach out" and
-- the office had to book them by phone, which is exactly what Joey reported.
alter type app.booking_source add value if not exists 'estimate';
