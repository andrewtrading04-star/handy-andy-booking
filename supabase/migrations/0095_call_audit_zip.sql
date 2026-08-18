-- Caller zip on a graded call.
--
-- Jiyah's dashboard redesign (Aug 2026) shows a Zip column in the audit log
-- and searches by it. Free text typed by the auditor off the recording, same
-- trust level as caller_name/caller_phone from 0091: Grasshopper has no API,
-- so everything about the caller is read off the screen or heard by hand.
alter table app.call_audits add column if not exists caller_zip text;

comment on column app.call_audits.caller_zip is 'Zip the caller gave on the recording, typed by the auditor. Usually the job address zip. Often null.';
