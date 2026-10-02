-- Joey's own tasks: 4th task group (owner 2026-10-02).
alter table app.assistant_tasks drop constraint if exists assistant_tasks_color_check;
alter table app.assistant_tasks add constraint assistant_tasks_color_check check (color in ('red','yellow','green','joey'));
