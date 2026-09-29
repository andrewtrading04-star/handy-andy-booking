-- Photos customers text us (MMS): how many; the files stay at Twilio (owner 2026-09-30).
alter table app.messages add column if not exists media_count int not null default 0;
