-- ============================================================================
-- Migration 0117: Per-line missed-call auto-text
-- ----------------------------------------------------------------------------
-- Owner request 2026-09-18: when a call to a Twilio tracking line rings out
-- (nobody picks up), text the caller from that same line. The wording lives
-- here, per line, so turning it on/off or changing it is a data change, not a
-- deploy. NULL or blank = off (every line except the three below).
--
-- Read by api/analytics.js handleVoiceStatus -> sendMissedCallText, which
-- selects this column in its own lookup. Every other tracking_numbers select
-- lists its columns explicitly, so adding one breaks none of them.
--
-- Enabled on the three Handy Andy lines that are on Twilio and in the A2P
-- 10DLC campaign's sender pool: San Antonio, Los Angeles, Phoenix.
-- NOT 7138769032 (owner: not applicable). The owner's other numbers are on
-- Grasshopper and are handled in Grasshopper's own portal.
--
-- Owner-written text, verbatim; E'' so \n are real newlines (blank line
-- after the first sentence).
-- ============================================================================
alter table app.tracking_numbers
  add column if not exists missed_call_text text;

comment on column app.tracking_numbers.missed_call_text is
  'Text sent FROM this line to a caller whose call rang out unanswered (api/analytics.js voice_status). NULL/blank = off. Migration 0117.';

update app.tracking_numbers
   set missed_call_text = E'Sorry we missed your call! We will return your call as soon as possible.\n\nUntil then, you can book your appointment automatically here:\nihandyandy.com/book'
 where phone in ('2106101714', '2135793329', '4804854695');

-- Guard: exactly those three lines, and nothing else, carry the text.
do $$
declare
  n_on int;
  n_target int;
begin
  select count(*) into n_on from app.tracking_numbers
   where missed_call_text is not null and btrim(missed_call_text) <> '';
  select count(*) into n_target from app.tracking_numbers
   where phone in ('2106101714', '2135793329', '4804854695')
     and missed_call_text like E'Sorry we missed your call!%\n\nUntil then,%\nihandyandy.com/book';
  if n_on <> 3 or n_target <> 3 then
    raise exception 'missed_call_text: expected exactly 3 lines enabled, got % enabled / % matching', n_on, n_target;
  end if;
end $$;
