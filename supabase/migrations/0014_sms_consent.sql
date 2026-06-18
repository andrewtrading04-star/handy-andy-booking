-- Add SMS consent tracking to bookings
-- This column tracks whether the customer consented to receive SMS updates

alter table app.bookings
add column if not exists sms_consent boolean not null default true;

-- Create index for querying bookings by SMS consent
create index if not exists idx_bookings_sms_consent on app.bookings(business_id, sms_consent)
where sms_consent = true;
