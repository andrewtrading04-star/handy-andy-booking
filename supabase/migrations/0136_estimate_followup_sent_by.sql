-- Who sent the $20-off coupon follow-up email on an estimate.
-- null = the 3-hour automatic send (api/_lib/estimate-followup.js cron);
-- a staff name = sent by hand with the "Send Quote via email (Coupon)"
-- button (owner rule 2026-09-23). Either way followup_emailed_at is stamped,
-- which is what stops the other one from ever sending a second coupon.
set search_path = app, public, extensions;
alter table estimates add column if not exists followup_sent_by text;
