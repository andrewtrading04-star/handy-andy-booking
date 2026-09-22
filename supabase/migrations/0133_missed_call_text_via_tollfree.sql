-- ============================================================================
-- Migration 0133: Missed-call text can leave from the toll-free sender instead
-- of the tracking line itself (Dom's, ported in 2026-09-22)
-- ----------------------------------------------------------------------------
-- The missed-call auto-text (0117) sends FROM the tracking line that rang,
-- which requires that line to sit in the A2P 10DLC Messaging Service pool.
-- That pool is registered to the Handy Andy brand. Dom's TV Mounting is a
-- different brand with no A2P registration of its own, so a text from Dom's
-- own number is rejected by the carriers (error 30034) -- until Dom's brand
-- is registered (started 2026-09-22, ~1-2 weeks) the number simply cannot
-- send.
--
-- Owner call, 2026-09-22: "substitute the 888 number in." The toll-free
-- 888-915-9967 (TWILIO_PHONE_NUMBER) is toll-free-verified and already
-- carries every other automated text, so a line flagged here sends its
-- missed-call text from the toll-free instead. The reply then lands on the
-- toll-free's thread in Messages, where the office already answers unmapped-
-- line texts under a per-customer brand guess (admin.js brandForUnmappedTexters).
--
-- Because the customer's phone shows an unfamiliar 888 number with no name,
-- the text itself must say who it is from -- hence "Dom's TV Mounting" in
-- the body below. Flip the flag off (and let the line send as itself) the
-- day Dom's own campaign is approved.
-- ============================================================================
set search_path = app, public, extensions;

alter table tracking_numbers
  add column if not exists missed_call_via_tollfree boolean not null default false;

comment on column app.tracking_numbers.missed_call_via_tollfree is
  'When true the missed-call auto-text is sent from TWILIO_PHONE_NUMBER (the toll-free) instead of this line, for a line whose brand has no A2P 10DLC registration. Off once the brand is registered and the line is in a sender pool.';

update tracking_numbers
   set missed_call_via_tollfree = true,
       missed_call_text = E'Dom''s TV Mounting here - sorry we missed your call! We will call you back as soon as possible.\n\nYou can also reply to this text with what you need.'
 where phone = '7208006095';
