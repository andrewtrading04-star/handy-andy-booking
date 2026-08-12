-- Caller identity on a graded call.
--
-- Until now a flagged call carried only the Grasshopper LINE it came in on,
-- which is one of our own numbers, so the owner had nothing to search on when
-- he went back to Grasshopper to listen. caller_phone is the number the
-- customer called from; caller_name is whatever the recording gives, often
-- nothing. Both are free text: Grasshopper has no API, so the auditor reads
-- them off the screen by hand.
alter table app.call_audits add column if not exists caller_phone text;
alter table app.call_audits add column if not exists caller_name  text;

-- The wall-clock time the auditor typed, as a literal 'HH:MM' string in
-- CENTRAL time, which is what Grasshopper displays regardless of market.
--
-- occurred_at alone could not be trusted: the form built it with
-- new Date(date+'T'+time), which parses in the AUDITOR'S browser timezone, and
-- she works from outside the US. Every time saved before this migration is
-- therefore shifted by her offset and does not match Grasshopper. Storing the
-- string she actually typed makes the display immune to that whole class of
-- bug, and its presence marks a row as saved by the fixed code -- rows with
-- time_local null are the old, unreliable ones.
alter table app.call_audits add column if not exists time_local text;

comment on column app.call_audits.caller_phone is 'Number the customer called from, typed by the auditor from the Grasshopper screen.';
comment on column app.call_audits.caller_name  is 'Caller name if the recording gives one. Usually null.';
comment on column app.call_audits.time_local   is 'HH:MM Central wall clock as shown in Grasshopper. Null on rows saved before 0091, whose occurred_at is shifted by the auditor browser timezone.';
