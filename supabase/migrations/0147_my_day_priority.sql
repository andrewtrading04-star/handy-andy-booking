-- My Day: three importance levels (owner rule 2026-09-25).
-- 0 = white (normal), 1 = green (important), 2 = red (most urgent).
-- `starred` is kept in sync (priority > 0) for older callers.
alter table app.owner_tasks add column if not exists priority smallint not null default 0 check (priority between 0 and 2);
update app.owner_tasks set priority = 1 where starred and priority = 0;
