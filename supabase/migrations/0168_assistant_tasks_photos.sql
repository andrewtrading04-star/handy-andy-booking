-- Pictures on tasks (owner 2026-10-02).
alter table app.assistant_tasks add column if not exists photo_urls text[] not null default '{}';
