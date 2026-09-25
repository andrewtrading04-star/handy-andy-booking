-- Take a Call counts toward conversion only once the secretary reached the
-- "Is there anything else?" card (owner, 2026-09-25). Handyman calls count once
-- past the description (they have no extras card).
alter table app.calls add column if not exists reached_extras boolean not null default false;
update app.calls c set reached_extras = true
where c.kind='live' and (
  c.reached_step in ('schedule','recap','discount','customer','estimate')
  or exists (select 1 from app.call_events e where e.call_id=c.id and (
    (e.event='question_answered' and e.meta->>'question'='extras') or e.event='options_done'
    or e.step in ('schedule','recap','discount','customer','estimate'))));
