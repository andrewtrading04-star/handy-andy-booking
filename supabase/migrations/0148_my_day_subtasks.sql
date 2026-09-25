-- My Day: main tasks with subtasks (owner rule 2026-09-25, e.g. "Build A1"
-- with Stripe / widget / ... underneath). One level deep.
alter table app.owner_tasks add column if not exists parent_id uuid references app.owner_tasks(id);
create index if not exists owner_tasks_parent_idx on app.owner_tasks(parent_id);
