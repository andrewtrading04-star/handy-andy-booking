-- Real delivery tracking for the tech app's "on the way" text (previously
-- fire-and-forget with no way to know if it actually reached the customer).
-- Twilio's status callback (api/analytics.js action=sms_status) flips
-- on_the_way_sms_status from 'pending' to 'delivered' or 'failed'/'undelivered'.
-- Admin/secretary dashboard only -- shapeBooking() in api/admin.js exposes
-- these fields; the tech app's own booking read (api/tech.js) never selects them.
alter table app.bookings
  add column if not exists on_the_way_sms_status text,
  add column if not exists on_the_way_sms_sent_at timestamptz,
  add column if not exists on_the_way_sms_delivered_at timestamptz;
