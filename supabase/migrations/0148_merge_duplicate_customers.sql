-- Merge duplicate customers v2 (owner, 2026-09-26: "yes merge them").
-- Conservative rules after review:
--  * group = same business_id + same last-10 phone digits
--  * keeper = most bookings, then latest job, then oldest row
--  * a copy is merged ONLY if it looks like the same person as the keeper
--    (same first name/nickname, same street, one name a prefix
--    of the other, or a blank/placeholder name). Different people stay separate.
--  * the keeper keeps ITS OWN name, email, card and address; copies only fill blanks.
--    Cards are never copied over. Everything dropped is kept in metadata + backup.
begin;
lock table app.calls, app.messages in exclusive mode;

create table app.customer_merge_20260926_bak as select * from app.customers where false;
create table app.customer_merge_20260926_map (loser_id uuid primary key, keeper_id uuid not null, business_id uuid not null, phone10 text not null);
create table app.customer_merge_20260926_repoint (tbl text not null, row_id uuid not null, old_customer_id uuid not null, new_customer_id uuid not null);

create temp table _c on commit drop as
select cu.*,
  right(regexp_replace(coalesce(cu.phone,''),'\D','','g'),10) as p10,
  (select count(*) from app.bookings b where b.customer_id = cu.id) as nb,
  (select max(b.scheduled_at) from app.bookings b where b.customer_id = cu.id) as last_job,
  trim(regexp_replace(lower(coalesce(cu.name,'')), '[^a-z ]', '', 'g')) as nn,
  lower(regexp_replace(coalesce(cu.address_line1,''), '[^A-Za-z0-9]', '', 'g')) as na
from app.customers cu;

create temp table _g on commit drop as
select c.*, row_number() over (partition by c.business_id, c.p10
         order by c.nb desc, c.last_job desc nulls last, c.created_at asc, c.id) as rk
from _c c
join (select business_id, p10 from _c where length(p10) = 10 group by 1,2 having count(*) > 1) g using (business_id, p10)
where c.p10 not in ('7203711561', '3374997817');   -- staff/training and the owner's test line

-- same-person test against the keeper
create temp table _m on commit drop as
select g.*, k.id as keeper_id,
  (g.rk = 1) or (
    g.nn = '' or g.nn = 'customer' or k.nn = '' or k.nn = 'customer'
    or split_part(g.nn,' ',1) = split_part(k.nn,' ',1)
    or (length(split_part(g.nn,' ',1)) >= 3 and left(split_part(g.nn,' ',1),3) = left(split_part(k.nn,' ',1),3))
    or position(g.nn in k.nn) = 1 or position(k.nn in g.nn) = 1
    or (g.na <> '' and g.na = k.na)
  ) as same_person
from _g g join _g k on k.business_id = g.business_id and k.p10 = g.p10 and k.rk = 1;

-- 1. backup every row involved (original state)
insert into app.customer_merge_20260926_bak
  select id, business_id, name, first_name, last_name, phone, email, address_line1, address_line2, city, state,
         postal_code, lat, lng, notes, tags, stripe_customer_id, zenbooker_customer_id, metadata, created_at, updated_at
  from _m where rk = 1 or same_person;

-- 2. map
insert into app.customer_merge_20260926_map (loser_id, keeper_id, business_id, phone10)
  select id, keeper_id, business_id, p10 from _m where rk > 1 and same_person;

-- 3. fill values (only used where the keeper is blank)
create temp table _k on commit drop as
select k.id as keeper_id,
  (select m.name from _m m where m.keeper_id = k.id and (m.rk = 1 or m.same_person) and m.nn not in ('', 'customer')
     order by length(m.nn) desc, m.last_job desc nulls last, m.id limit 1) as name,
  (select m.first_name from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and nullif(trim(m.first_name),'') is not null order by m.last_job desc nulls last, m.id limit 1) as first_name,
  (select m.last_name from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and nullif(trim(m.last_name),'') is not null order by m.last_job desc nulls last, m.id limit 1) as last_name,
  (select m.email from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and nullif(trim(m.email),'') is not null order by m.last_job desc nulls last, m.id limit 1) as email,
  (select m.id from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and nullif(trim(m.address_line1),'') is not null order by m.last_job desc nulls last, m.id limit 1) as addr_src,
  (select string_agg(x.n, E'\n' order by x.o) from (
     select distinct on (trim(m.notes)) trim(m.notes) n, m.rk o from _m m
     where m.keeper_id = k.id and (m.rk = 1 or m.same_person) and nullif(trim(m.notes),'') is not null order by trim(m.notes), m.rk) x) as notes,
  (select array_agg(distinct t) from _m m, unnest(coalesce(m.tags,'{}')) t where m.keeper_id = k.id and (m.rk = 1 or m.same_person)) as tags,
  (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from (
     select e.key, e.value, row_number() over (partition by e.key order by m.last_job desc nulls last, m.id) rn
     from _m m, jsonb_each(coalesce(m.metadata,'{}'::jsonb)) e where m.keeper_id = k.id and m.same_person and m.rk > 1) e where e.rn = 1) as other_meta,
  (select jsonb_agg(m.id) from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1) as merged_from,
  (select jsonb_agg(distinct m.name) from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and m.name is not null) as merged_names,
  (select jsonb_agg(distinct m.email) from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and nullif(trim(m.email),'') is not null) as merged_emails,
  (select jsonb_agg(distinct m.stripe_customer_id) from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and m.stripe_customer_id is not null) as merged_stripe,
  (select jsonb_agg(m.zenbooker_customer_id) from _m m where m.keeper_id = k.id and m.same_person and m.rk > 1 and m.zenbooker_customer_id is not null) as merged_zbk
from _m k where k.rk = 1 and exists (select 1 from _m m where m.keeper_id = k.id and m.rk > 1 and m.same_person);

-- 4. re-point jobs, calls, texts (job "last changed" time untouched)
alter table app.bookings disable trigger trg_bookings_updated;
with u as (update app.bookings b set customer_id = m.keeper_id from app.customer_merge_20260926_map m where b.customer_id = m.loser_id returning b.id, m.loser_id, m.keeper_id)
insert into app.customer_merge_20260926_repoint select 'bookings', id, loser_id, keeper_id from u;
alter table app.bookings enable trigger trg_bookings_updated;
with u as (update app.calls c set customer_id = m.keeper_id from app.customer_merge_20260926_map m where c.customer_id = m.loser_id returning c.id, m.loser_id, m.keeper_id)
insert into app.customer_merge_20260926_repoint select 'calls', id, loser_id, keeper_id from u;
with u as (update app.messages x set customer_id = m.keeper_id from app.customer_merge_20260926_map m where x.customer_id = m.loser_id returning x.id, m.loser_id, m.keeper_id)
insert into app.customer_merge_20260926_repoint select 'messages', id, loser_id, keeper_id from u;

-- 5. remove the merged copies
delete from app.customers c using app.customer_merge_20260926_map m where c.id = m.loser_id;

-- 6. keeper keeps its own values; blanks are filled from the copies
update app.customers c set
  name = case when c.name ~ '[A-Za-z]' and lower(trim(c.name)) <> 'customer' then c.name else coalesce(k.name, c.name) end,
  first_name = case when nullif(trim(c.first_name),'') is not null then c.first_name else coalesce(k.first_name, c.first_name) end,
  last_name = case when nullif(trim(c.last_name),'') is not null then c.last_name else coalesce(k.last_name, c.last_name) end,
  email = case when nullif(trim(c.email),'') is not null then c.email else coalesce(k.email, c.email) end,
  address_line1 = case when nullif(trim(c.address_line1),'') is null and a.id is not null then a.address_line1 else c.address_line1 end,
  address_line2 = case when nullif(trim(c.address_line1),'') is null and a.id is not null then a.address_line2 else c.address_line2 end,
  city          = case when nullif(trim(c.address_line1),'') is null and a.id is not null then coalesce(a.city, c.city) else c.city end,
  state         = case when nullif(trim(c.address_line1),'') is null and a.id is not null then coalesce(a.state, c.state) else c.state end,
  postal_code   = case when nullif(trim(c.address_line1),'') is null and a.id is not null then coalesce(a.postal_code, c.postal_code) else c.postal_code end,
  lat           = case when nullif(trim(c.address_line1),'') is null and a.id is not null then a.lat else c.lat end,
  lng           = case when nullif(trim(c.address_line1),'') is null and a.id is not null then a.lng else c.lng end,
  notes = coalesce(k.notes, c.notes),
  tags = coalesce(k.tags, c.tags),
  metadata = k.other_meta || coalesce(c.metadata, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object('merged_from', k.merged_from, 'merged_at', '2026-09-26',
         'merged_names', k.merged_names, 'merged_emails', k.merged_emails,
         'merged_stripe_ids', k.merged_stripe, 'merged_zenbooker_ids', k.merged_zbk))
from _k k left join _m a on a.id = k.addr_src
where c.id = k.keeper_id;

-- 7. safety checks (any failure rolls everything back)
do $$
declare n int;
begin
  select count(*) into n from app.bookings b left join app.customers c on c.id = b.customer_id where b.customer_id is not null and c.id is null;
  if n > 0 then raise exception '% bookings point at a missing customer', n; end if;
  select count(*) into n from app.customers c join app.customer_merge_20260926_map m on m.loser_id = c.id;
  if n > 0 then raise exception '% merged copies still present', n; end if;
  select count(*) into n from app.customers c join app.customer_merge_20260926_bak b on b.id = c.id
    where coalesce(b.stripe_customer_id,'') <> coalesce(c.stripe_customer_id,'')
       or (nullif(trim(b.email),'') is not null and b.email <> c.email);
  if n > 0 then raise exception '% keepers had their card or email changed', n; end if;
end $$;

commit;

-- Applied 2026-09-26 via SQL editor (not re-runnable: tables already exist).
-- Result: 466 copies merged into 386 customers; 12 bookings + 3 calls re-pointed;
-- 22 phone groups left alone (different people, staff/training, owner test line).
alter table app.customer_merge_20260926_bak enable row level security;
alter table app.customer_merge_20260926_map enable row level security;
alter table app.customer_merge_20260926_repoint enable row level security;
-- UNDO (if ever needed): re-insert rows from customer_merge_20260926_bak that are
-- missing from app.customers, restore keeper rows from the backup, then
--   update app.bookings b set customer_id = r.old_customer_id from app.customer_merge_20260926_repoint r
--     where r.tbl = 'bookings' and b.id = r.row_id;   (same for calls/messages)
