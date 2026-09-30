-- Per-person schedules for Dom's extra secretaries (Alex, Joe) and notes
-- addressed to ONE person (owner 2026-09-30). Heather/Joey keep using
-- secretary_availability (per business, drives pay); these rows never do.
create table if not exists app.staff_schedules (
  name text not null, business_slug text not null, day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null default '08:00', end_time time not null default '20:00', timezone text not null default 'America/Denver',
  updated_at timestamptz not null default now(), primary key (name, day_of_week));
alter table app.staff_notes add column if not exists target_name text;
