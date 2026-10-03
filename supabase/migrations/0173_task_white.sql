-- Task colors (owner 2026-10-03): red = drop everything (texts Joey),
-- yellow = ASAP, green = soon, white = whenever. joey = her own list.
alter table app.assistant_tasks drop constraint if exists assistant_tasks_color_check;
alter table app.assistant_tasks add constraint assistant_tasks_color_check
  check (color = any (array['red','yellow','green','white','joey']));
