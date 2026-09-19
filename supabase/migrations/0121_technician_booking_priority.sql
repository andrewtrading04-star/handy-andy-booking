-- Migration 0121: technician booking priority (applied 2026-09-19)
-- Higher number = offered new online bookings first when several techs are free
-- for the same slot (pickOpenTech). Equal priority falls back to fewest jobs
-- this week, as before. Gregory set to 1 so he outranks TK (0) in Dom's Denver.
set search_path = app, public;
alter table technicians add column if not exists booking_priority smallint not null default 0;
update technicians set booking_priority = 1 where name = 'Gregory' and active;
notify pgrst, 'reload schema';
