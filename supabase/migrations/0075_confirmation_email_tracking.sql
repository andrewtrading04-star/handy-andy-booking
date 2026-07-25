-- Real status for the branded "you're booked" confirmation email (previously
-- fire-and-forget with nothing persisted -- the office had no way to tell a
-- customer who says "I never got a confirmation" whether it was ever actually
-- sent). Written right after the send attempt in api/book.js (bookDoms,
-- bookHandyAndy) and api/admin.js (bookingCreate) -- 'sent' or 'failed', with
-- no third-party delivery webhook to upgrade it further (Resend has no
-- inbound status callback wired up here the way Twilio's SMS status is).
alter table app.bookings
  add column if not exists confirmation_email_status text,
  add column if not exists confirmation_email_sent_at timestamptz;
