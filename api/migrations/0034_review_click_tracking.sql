-- Replace email open-pixel with unified click-tracking for email + SMS.
-- This migration adds 3 new columns:
--   review_clicked_at: when customer clicked the review link (first click only)
--   review_click_channel: 'email' or 'sms' (which channel they clicked from)
--   review_sms_sent_at: when the SMS review request was sent (parallels review_email_sent_at)
--
-- The old review_email_opened_at column is no longer used but left in place for back-compat.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_clicked_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_click_channel TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_sms_sent_at TIMESTAMPTZ;

-- Index for performant "has the customer clicked" checks in the reviews list
CREATE INDEX IF NOT EXISTS bookings_review_clicked_at_idx ON bookings(business_id, review_clicked_at DESC);
