-- Owner 2026-10-06: drag tasks into any order.
alter table app.assistant_tasks add column if not exists sort_order double precision;
