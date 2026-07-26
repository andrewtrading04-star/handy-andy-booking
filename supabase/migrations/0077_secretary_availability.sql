-- Secretary weekly availability (Heather — Handy Andy, Joey — Dom's). Whole-day
-- on/off, not slot-based like technician_availability — a secretary is paid a
-- flat $95/day, not per job, so there's no time-of-day granularity to track.
-- One row per business per day-of-week (the recurring pattern), plus a
-- date-specific exceptions table for one-off changes (a day off this week
-- only), mirroring the technician_availability / _exceptions pair.
create table if not exists app.secretary_availability (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app.businesses(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  is_available boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (business_id, day_of_week)
);

create table if not exists app.secretary_availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app.businesses(id) on delete cascade,
  exception_date date not null,
  is_available boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (business_id, exception_date)
);

-- Seed the default Mon-Fri working pattern for both businesses so the
-- "My Availability" / "Secretaries" screens show something sane on first
-- load instead of an empty grid.
insert into app.secretary_availability (business_id, day_of_week, is_available)
select b.id, d.dow, (d.dow between 1 and 5)
from app.businesses b
cross join (select generate_series(0,6) as dow) d
where b.slug in ('handy-andy', 'doms')
on conflict (business_id, day_of_week) do nothing;
