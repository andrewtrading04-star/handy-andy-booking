-- "My Day": the owner's personal notepad-style planner (owner-only CRM tab).
-- Owner rule 2026-09-23. A "day" is Bangkok time and turns over at 5 AM, so a
-- late night still counts as the same page (api/admin.js myDayToday()).
set search_path = app, public, extensions;

-- One row per task. origin_day = the page it was first written on. A task with
-- no done_at shows on every page from origin_day onward ("carried over"), so
-- nothing is copied when the page turns. done_day = the page it was crossed off.
create table if not exists owner_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  origin_day date not null,
  done_at timestamptz,
  done_day date,
  starred boolean not null default false,
  time_hint text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists owner_tasks_open_idx on owner_tasks (origin_day) where done_at is null and deleted_at is null;

-- Daily habits (Gym, Free time, Asleep by 1 AM, ...) and one row per day checked.
create table if not exists owner_habits (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists owner_habit_checks (
  habit_id uuid not null references owner_habits(id) on delete cascade,
  day date not null,
  checked_at timestamptz not null default now(),
  primary key (habit_id, day)
);

-- "Keep in mind" list: no day at all (groceries etc.). Stays until checked.
create table if not exists owner_list_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table owner_tasks enable row level security;
alter table owner_habits enable row level security;
alter table owner_habit_checks enable row level security;
alter table owner_list_items enable row level security;

insert into owner_habits (name, sort)
select * from (values ('Gym', 1), ('Free time', 2), ('Asleep by 1 AM', 3)) v(name, sort)
where not exists (select 1 from owner_habits);
