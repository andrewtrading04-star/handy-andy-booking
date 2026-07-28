-- Who is on the phone with this caller right now.
-- The office problem this solves: Heather misses a call, rings the customer
-- back, and Joey later rings the same customer because the voicemail still
-- looks unanswered. A claim is visible to everyone the moment it is taken.
alter table app.calls
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz;

-- 'calling' = someone has picked it up and is dialing.
comment on column app.calls.status is
  'new | calling | called_back | resolved | ignored';
