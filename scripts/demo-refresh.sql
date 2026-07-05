-- ============================================================================
-- DEMO REFRESH — paste into the Supabase SQL Editor and Run.
-- Use this on an EXISTING demo database (already set up with demo-setup.sql).
-- It does NOT re-run the migrations, so it's safe and idempotent to re-run.
-- Applies two updates:
--   1) De-brand service names so "Dom's / Handy Andy / TV Mounting" never
--      surface anywhere (e.g. Review Calls, which shows the service name).
--   2) Re-spread the current Sun–Sat payroll week so a few jobs land on EACH
--      day instead of clustering on one day.
-- ============================================================================
set search_path = app, public, extensions;

-- ── 1) De-brand service names ───────────────────────────────────────────────
-- A prior full-bundle re-run can leave an orphan 0001 "TV Installation"
-- placeholder (no bookings) next to the real "Dom's TV Mounting". Drop those
-- orphans first so the rename below can't collide on (business_id, name).
delete from services s
 where s.name = 'TV Installation'
   and not exists (select 1 from bookings bk where bk.service_id = s.id);

-- Rename any brand-named service to a generic label. Guard with NOT EXISTS so
-- the update can never violate the (business_id, name) unique constraint.
update services s set name = 'TV Installation'
 where ( s.name ilike '%tv mounting%' or s.name ilike '%handy andy%'
      or s.name ilike '%dom''s%'     or s.name ilike '%doms%'
      or s.name ilike '%camelback%'  or s.name ilike '%gold coast%' )
   and not exists (
     select 1 from services s2
      where s2.business_id = s.business_id and s2.name = 'TV Installation' and s2.id <> s.id
   );

-- ── 2) Re-spread the current-week payroll jobs across every day ─────────────
do $$
declare
  b record;
  tech_ids uuid[]; svc_id uuid; area_id uuid; cid uuid; tid uuid; bk_id uuid;
  size_labels  text[]    := array['33"-59"','60"-69"','70"-84"','85"-97"'];
  size_prices  numeric[] := array[109,119,149,179];
  addon_labels text[]    := array['Soundbar installation','Hide wires behind the wall (in-wall)','LED accent lights behind TV'];
  addon_prices numeric[] := array[50,75,50];
  wk_sunday date := current_date - extract(dow from current_date)::int;  -- Sunday of current week
  ntech int; dd int; j2 int; si int; ai int; sched timestamptz; price numeric; day_date date;
begin
  for b in select id, slug from businesses where slug in ('handy-andy','doms') loop
    select array_agg(id) into tech_ids from technicians where business_id=b.id and active=true;
    ntech := coalesce(array_length(tech_ids,1),0);
    select id into svc_id from services where business_id=b.id limit 1;
    -- re-runnable: clear any completed jobs already sitting in the current week
    delete from booking_line_items li using bookings bk
      where li.booking_id=bk.id and bk.business_id=b.id and bk.status='completed'
        and bk.scheduled_at >= wk_sunday::timestamptz;
    delete from bookings
      where business_id=b.id and status='completed' and scheduled_at >= wk_sunday::timestamptz;
    if ntech = 0 then continue; end if;
    -- spread a few completed+paid jobs across EVERY day of the current Sun–Sat week
    for dd in 0..6 loop
      day_date := wk_sunday + dd;
      for j2 in 1..(3 + (dd % 2)) loop   -- 3–4 jobs each day, rotating techs
        tid := tech_ids[1 + ((dd*3 + j2) % ntech)];
        select id into cid from customers      where business_id=b.id order by random() limit 1;
        select id into area_id from service_areas where business_id=b.id order by random() limit 1;
        si := 1 + ((dd+j2) % array_length(size_labels,1));
        ai := 1 + ((dd+j2) % array_length(addon_labels,1));
        price := size_prices[si] + addon_prices[ai];
        sched := day_date::timestamptz + ((8 + (j2*2))||' hours')::interval;
        insert into bookings (business_id, customer_id, technician_id, service_id, service_area_id,
               status, source, scheduled_at, scheduled_end, duration_minutes, subtotal, price,
               payment_status, address_line1, city, state, postal_code, completed_at)
        select b.id, cid, tid, svc_id, area_id, 'completed'::booking_status, 'widget'::booking_source,
               sched, sched + interval '90 minutes', 90, price, price, 'paid'::payment_status,
               c.address_line1, c.city, c.state, c.postal_code, sched + interval '90 minutes'
        from customers c where c.id=cid
        returning id into bk_id;
        insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
          values (bk_id, b.id, 'service', 'TV Size: '||size_labels[si], 1, size_prices[si], size_prices[si]);
        insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
          values (bk_id, b.id, 'addon', addon_labels[ai], 1, addon_prices[ai], addon_prices[ai]);
      end loop;
    end loop;
  end loop;
end $$;

-- ── 3) Move the overdue red-glow job from Jun 2 → Jul 2 ─────────────────────
do $$
declare bz uuid; c uuid; t uuid; s uuid; a uuid; bk uuid;
begin
  select id into bz from businesses where slug='handy-andy';
  select id into c  from customers      where business_id=bz order by random() limit 1;
  select id into t  from technicians    where business_id=bz and active=true limit 1;
  select id into s  from services        where business_id=bz limit 1;
  select id into a  from service_areas   where business_id=bz order by random() limit 1;
  -- remove the old Jun 2 job and any existing Jul 2 one (re-runnable)
  delete from bookings where business_id=bz and status='in_progress' and payment_status='unpaid'
    and scheduled_at::date in (date '2026-07-02', date '2026-06-02');
  insert into bookings (business_id, customer_id, technician_id, service_id, service_area_id,
         status, source, scheduled_at, scheduled_end, duration_minutes, subtotal, price,
         payment_status, address_line1, city, state, postal_code)
  select bz, c, t, s, a, 'in_progress'::booking_status, 'manual'::booking_source,
         timestamptz '2026-07-02 14:00-07', timestamptz '2026-07-02 15:30-07', 90, 149, 149,
         'unpaid'::payment_status, cu.address_line1, cu.city, cu.state, cu.postal_code
  from customers cu where cu.id=c
  returning id into bk;
  insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
    values (bk, bz, 'service', 'TV Size: 70"-84"', 1, 149, 149);
end $$;

-- Verify:
--   select distinct name from services order by 1;              -- no brand names
--   select scheduled_at::date, count(*) from bookings
--     where status='completed' and scheduled_at >= current_date - extract(dow from current_date)::int
--     group by 1 order by 1;                                    -- a few jobs per day
