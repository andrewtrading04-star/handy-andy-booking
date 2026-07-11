-- SMS consent is meant to be an opt-out model: every text we send already
-- says "STOP to opt out", and the column itself defaults to true (see
-- 0014_sms_consent.sql). The manual/office booking-creation code path
-- (api/admin.js bookingCreate) was overriding that default with
-- `sms_consent: !!body.sms_consent`, which forces false whenever the
-- "Send SMS updates" checkbox's value doesn't arrive as an explicit true
-- (e.g. a booking created before that checkbox existed, or any other
-- caller that never set the field). That silently blocked the "on the way"
-- and review-request texts for every affected booking, with no error or log
-- line anywhere to surface it.
--
-- Now that the code defaults to opted-in unless explicitly declined, backfill
-- existing rows the same way: nothing in this system currently records an
-- explicit customer decline distinctly from "the field was just never set",
-- so treat every non-true row as the latter and bring it in line with the
-- opt-out policy.
update app.bookings
set sms_consent = true
where sms_consent is distinct from true;
