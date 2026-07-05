-- ============================================================================
-- DEMO SEED — 100% fictional data for the sales sandbox. Run AFTER all migrations.
-- Renames the two businesses to Camelback / Gold Coast TV Mounting and fills the
-- schedule, dashboard, payroll, and estimates with fake bookings/customers/techs.
-- Re-runnable: clears prior bookings/customers/estimates for both businesses.
-- No real names, phones, addresses, or money anywhere.
-- ============================================================================
set search_path = app, public, extensions;

do $$
declare
  b record; a record;
  tech_ids uuid[]; cust_ids uuid[];
  first_names text[] := array['Emma','Liam','Olivia','Noah','Ava','Ethan','Sophia','Mason','Isabella','Lucas','Mia','Jackson','Harper','Aiden','Ella','Grayson','Chloe','Leo','Nora','Owen','Zoe','Caleb','Lily','Wyatt','Aria','Micah'];
  last_names text[]  := array['Nguyen','Patel','Kim','Reyes','Bennett','Foster','Sullivan','Hughes','Barrett','Chen','Delgado','Meyer','Osborne','Fletcher','Vargas','Snyder','Bishop','Cross','Lane','Marsh','Frost','Wade','Booth','Yates','Hale','Pope'];
  streets text[] := array['Camelback Rd','Maple Ave','Oak St','Sunset Blvd','Willow Ln','Birch Ct','Cedar Way','Palm Dr','Aspen St','Juniper Rd','Lakeview Dr','Cactus Ave','Harbor St','Lincoln Ave'];
  size_labels text[] := array['32" Or Less','33"-59"','60"-69"','70"-84"','85"-97"'];
  size_prices numeric[] := array[99,109,119,149,179];
  addon_labels text[] := array['Soundbar installation','Hide wires behind the wall (in-wall)','Hide wires outside the wall (cord cover)','LED accent lights behind TV'];
  addon_prices numeric[] := array[50,75,25,50];
  reviews text[] := array['Fantastic job, super clean and fast!','On time and professional. Highly recommend.','Looks amazing on the wall. Thank you!','Great communication and tidy work.','Wires are perfectly hidden. Very happy.'];
  tech_names_ha text[] := array['Marcus Bell','Diego Ortiz','Ryan Cole','Tyler Fox'];
  tech_names_gc text[] := array['Andre Silva','Chris Nolan','Priya Shah'];
  colors text[] := array['#2563eb','#f97316','#16a34a','#db2777','#7c3aed'];
  new_areas_ha text[] := array['Phoenix','Scottsdale','Tempe'];
  i int; d int; j int; ac text;
  svc_id uuid; area_id uuid; tid uuid; cid uuid; bk_id uuid;
  fn text; ln text; city text; zip text; st text;
  sizeidx int; addidx int; useaddon boolean; price numeric; sizep numeric; addp numeric;
  sched timestamptz; is_past boolean; is_today boolean; bstatus text; reviewed boolean;
begin
  -- Business identities
  update businesses set name='Camelback TV Mounting',  url='https://camelbacktv.example.com',  support_email='office@camelbacktv.example.com',  support_phone='(602) 555-0142', timezone='America/Phoenix' where slug='handy-andy';
  update businesses set name='Gold Coast TV Mounting', url='https://goldcoasttv.example.com',   support_email='office@goldcoasttv.example.com',   support_phone='(312) 555-0177', timezone='America/Chicago' where slug='doms';

  -- Owner + secretary display names
  update staff_users set name='Trenton Maddox' where role='owner';
  update staff_users s set name='Sam Rivera' from businesses bz where s.business_id=bz.id and bz.slug='handy-andy' and s.role<>'owner';
  update staff_users s set name='Jordan Lee' from businesses bz where s.business_id=bz.id and bz.slug='doms'       and s.role<>'owner';

  for b in select id, slug from businesses where slug in ('handy-andy','doms') loop
    if b.slug='handy-andy' then ac := '602'; else ac := '312'; end if;

    -- Service areas (rename in place)
    if b.slug='handy-andy' then
      i := 1;
      for a in select id from service_areas where business_id=b.id order by created_at loop
        if i<=3 then update service_areas set name=new_areas_ha[i], state='AZ', timezone='America/Phoenix' where id=a.id; end if;
        i := i+1;
      end loop;
    else
      update service_areas set name='Chicago', state='IL', timezone='America/Chicago' where business_id=b.id;
    end if;

    -- Technicians: rename by row order, set phone/color, add a 3rd for Gold Coast, PIN 1234
    i := 1; tech_ids := array[]::uuid[];
    for a in select id from technicians where business_id=b.id order by created_at loop
      if b.slug='handy-andy' and i<=array_length(tech_names_ha,1) then
        update technicians set name=tech_names_ha[i], phone='+1'||ac||'5550'||lpad((100+i)::text,3,'0'), email=lower(split_part(tech_names_ha[i],' ',1))||'@'||b.slug||'.example.com', color=colors[((i-1)%5)+1], active=true, status='off' where id=a.id;
        tech_ids := tech_ids || a.id;
      elsif b.slug='doms' and i<=array_length(tech_names_gc,1) then
        update technicians set name=tech_names_gc[i], phone='+1'||ac||'5550'||lpad((100+i)::text,3,'0'), email=lower(split_part(tech_names_gc[i],' ',1))||'@'||b.slug||'.example.com', color=colors[((i-1)%5)+1], active=true, status='off' where id=a.id;
        tech_ids := tech_ids || a.id;
      end if;
      i := i+1;
    end loop;
    if b.slug='doms' and coalesce(array_length(tech_ids,1),0) < 3 then
      insert into technicians (business_id, name, phone, color, active) values (b.id, tech_names_gc[3], '+1'||ac||'5550103', colors[3], true) returning id into tid;
      tech_ids := tech_ids || tid;
    end if;
    foreach tid in array tech_ids loop perform set_technician_pin(tid, '1234'); end loop;

    select id into svc_id from services where business_id=b.id limit 1;

    -- Clean prior demo rows
    delete from bookings  where business_id=b.id;
    delete from customers where business_id=b.id;
    delete from estimates where business_id=b.id;

    -- Customers
    cust_ids := array[]::uuid[];
    for i in 1..26 loop
      fn := first_names[1+floor(random()*array_length(first_names,1))::int];
      ln := last_names[1+floor(random()*array_length(last_names,1))::int];
      if b.slug='handy-andy' then
        city := (array['Phoenix','Scottsdale','Tempe'])[1+floor(random()*3)::int]; zip := (array['85018','85251','85281'])[1+floor(random()*3)::int]; st := 'AZ';
      else
        city := (array['Chicago','Evanston'])[1+floor(random()*2)::int]; zip := (array['60610','60201'])[1+floor(random()*2)::int]; st := 'IL';
      end if;
      insert into customers (business_id, name, first_name, last_name, phone, email, address_line1, city, state, postal_code)
      values (b.id, fn||' '||ln, fn, ln, '('||ac||') 555-'||lpad((1000+i)::text,4,'0'), lower(fn)||'.'||lower(ln)||i||'@example.com',
              (100+floor(random()*8900))::int::text||' '||streets[1+floor(random()*array_length(streets,1))::int], city, st, zip)
      returning id into cid;
      cust_ids := cust_ids || cid;
    end loop;

    -- Bookings across -14 … +14 days
    for d in -14..14 loop
      for j in 1..(3+floor(random()*3)::int) loop   -- 3-5 jobs every day
        cid := cust_ids[1+floor(random()*array_length(cust_ids,1))::int];
        tid := tech_ids[1+floor(random()*array_length(tech_ids,1))::int];
        sched := date_trunc('day', now()) + (d||' days')::interval + ((9+floor(random()*8))||' hours')::interval;
        sizeidx := 1+floor(random()*array_length(size_labels,1))::int; sizep := size_prices[sizeidx];
        useaddon := random() < 0.5;
        addidx := 1+floor(random()*array_length(addon_labels,1))::int;
        addp := case when useaddon then addon_prices[addidx] else 0 end;
        price := sizep + addp;
        is_past := d < 0; is_today := d = 0;
        bstatus := case when is_past then 'completed' when is_today then (array['assigned','on_the_way','in_progress'])[1+floor(random()*3)::int] else (array['confirmed','assigned','assigned'])[1+floor(random()*3)::int] end;
        reviewed := is_past and random() < 0.55;
        select id into area_id from service_areas where business_id=b.id order by random() limit 1;
        insert into bookings (business_id, customer_id, technician_id, service_id, service_area_id, status, source, scheduled_at, scheduled_end, duration_minutes, subtotal, price, payment_status, address_line1, city, state, postal_code, completed_at, review_rating, review_text, reviewed_at)
        select b.id, cid, tid, svc_id, area_id, bstatus::booking_status, (array['widget','manual','phone'])[1+floor(random()*3)::int]::booking_source, sched, sched + interval '90 minutes', 90, price, price,
               (case when is_past then 'paid' else 'card_on_file' end)::payment_status, c.address_line1, c.city, c.state, c.postal_code,
               case when is_past then sched + interval '90 minutes' else null end,
               case when reviewed then (case when random()<0.8 then 5 else 4 end) else null end,
               case when reviewed then reviews[1+floor(random()*array_length(reviews,1))::int] else null end,
               case when reviewed then sched + interval '90 minutes' else null end
        from customers c where c.id=cid
        returning id into bk_id;
        insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
        values (bk_id, b.id, 'service', 'TV Size: '||size_labels[sizeidx], 1, sizep, sizep);
        if useaddon then
          insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
          values (bk_id, b.id, 'addon', addon_labels[addidx], 1, addp, addp);
        end if;
      end loop;
    end loop;

    -- Estimates: one new, one sent w/ upsells, one approved
    insert into estimates (business_id, customer_name, customer_phone, customer_email, service_label, description, status, source, sms_consent)
      select b.id, c.name, c.phone, c.email, 'TV mount over fireplace', 'Customer wants a 65" mounted above a gas fireplace with wires hidden.', 'new', 'widget', true from customers c where c.business_id=b.id order by random() limit 1;
    insert into estimates (business_id, customer_name, customer_phone, customer_email, service_label, description, status, source, sms_consent, line_items, tax_rate, upsells)
      select b.id, c.name, c.phone, c.email, 'Two-TV install', 'Living room + bedroom mounts.', 'contacted', 'widget', true,
        '[{"description":"65\" TV mount","qty":1,"unit_price":149},{"description":"50\" TV mount","qty":1,"unit_price":109}]'::jsonb, 0.0875,
        '[{"id":"u0","description":"Soundbar installation","qty":1,"unit_price":50,"tech_pay":25,"badge":"","blurb":"","default_on":false},{"id":"u1","description":"Hide wires behind the wall (in-wall)","qty":1,"unit_price":75,"tech_pay":38,"badge":"","blurb":"","default_on":false}]'::jsonb
      from customers c where c.business_id=b.id order by random() limit 1;
    insert into estimates (business_id, customer_name, customer_phone, customer_email, service_label, description, status, source, sms_consent, line_items, tax_rate, upsells, approved_at, accepted_upsells, approved_total)
      select b.id, c.name, c.phone, c.email, 'Soundbar + mount', 'Approved job.', 'scheduled', 'widget', true,
        '[{"description":"70\" TV mount","qty":1,"unit_price":149}]'::jsonb, 0.0875,
        '[{"id":"u0","description":"Soundbar installation","qty":1,"unit_price":50,"tech_pay":25,"badge":"","blurb":"","default_on":false}]'::jsonb,
        now() - interval '2 days',
        '[{"id":"u0","description":"Soundbar installation","qty":1,"unit_price":50,"tech_pay":25}]'::jsonb,
        round((149+50)*1.0875, 2)
      from customers c where c.business_id=b.id order by random() limit 1;
  end loop;
end $$;

-- Verify:
--   select slug, name from businesses;
--   select b.name, count(*) from bookings k join businesses b on b.id=k.business_id group by 1;

-- ============================================================================
-- SCRUB: remove Guaranteed Dismount Service + Asurion from the demo catalog.
-- ============================================================================
set search_path = app, public, extensions;
delete from service_options o using service_option_groups g where o.group_id=g.id and (g.key='dismount' or o.label ilike '%dismount%' or o.label ilike '%tv removal%');
delete from service_option_groups where key='dismount';
delete from service_options o using service_option_groups g join services s on s.id=g.service_id where o.group_id=g.id and (s.name ilike '%asurion%' or coalesce(s.category,'') ilike '%asurion%');
delete from services where name ilike '%dismount%' or name ilike '%asurion%' or coalesce(category,'') ilike '%asurion%';
-- De-brand service names so nothing shows "Dom's / Handy Andy / <biz> TV Mounting"
-- (these surface in Review Calls via row.service.name). Give them a generic label.
update services set name='TV Installation'
  where name ilike '%tv mounting%' or name ilike '%handy andy%' or name ilike '%dom''s%'
     or name ilike '%doms%' or name ilike '%camelback%' or name ilike '%gold coast%';

-- ===================== technician availability =====================
-- ============================================================================
-- Demo seed: weekly technician availability (Mon–Fri daytime) for both demo
-- businesses (slugs 'handy-andy' / 'doms'). Idempotent + re-runnable:
-- deletes each demo tech's existing availability first, then re-inserts.
-- Time is NOT free-form — it is encoded by the five fixed slot_key values.
-- Mon–Fri 09:00–17:00 daytime window maps to the daytime slots:
--   s1 (08:00–10:00), s2 (11:00–13:00), s3 (14:00–16:00).
-- day_of_week encoding: 0=Sun … 6=Sat, so Mon–Fri = 1,2,3,4,5.
-- ============================================================================
begin;

-- 1) Clear existing availability for every technician in both demo businesses.
with demo_techs as (
  select t.id as technician_id
  from app.technicians t
  join app.businesses b on b.id = t.business_id
  where b.slug in ('handy-andy', 'doms')
)
delete from app.technician_availability a
using demo_techs dt
where a.technician_id = dt.technician_id;

-- 2) Insert Mon–Fri × daytime slots for every technician in both demo businesses.
with demo_techs as (
  select t.id as technician_id, t.business_id
  from app.technicians t
  join app.businesses b on b.id = t.business_id
  where b.slug in ('handy-andy', 'doms')
)
insert into app.technician_availability (business_id, technician_id, day_of_week, slot_key)
select dt.business_id,
       dt.technician_id,
       d.day_of_week::smallint,
       s.slot_key
from demo_techs dt
cross join (values (1), (2), (3), (4), (5)) as d(day_of_week)   -- Mon–Fri (0=Sun..6=Sat)
cross join (values ('s1'), ('s2'), ('s3')) as s(slot_key)       -- daytime slots ≈ 09:00–17:00
on conflict (technician_id, day_of_week, slot_key) do nothing;

commit;

-- ===================== current-week payroll jobs =====================
-- Populate the current Sun–Sat week of the Payroll report with completed+paid
-- jobs for both businesses, so the page is full on open (not just after "prev week").
set search_path = app, public, extensions;
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
    -- (full week, not just "so far") so the Payroll page looks full on any view day.
    for dd in 0..6 loop
      day_date := wk_sunday + dd;
      for j2 in 1..(3 + (dd % 2)) loop   -- 3–4 jobs each day, rotating techs → schedule-matching payroll
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

-- ===================== bracket / wire-plate inventory =====================
-- ============================================================================
-- DEMO SEED: Bracket + wire-plate inventory per technician (100% FICTIONAL)
-- Schema: app. Idempotent / re-runnable. Run AFTER migrations + scripts/demo-seed.sql.
-- Businesses:  handy-andy => Camelback TV Mounting  |  doms => Gold Coast TV Mounting
-- On-hand counts live in app.bracket_inventory (unique on business_id, technician_id);
-- app.bracket_purchases feeds the "Recent Walmart Orders" / pending-delivery list.
-- ============================================================================
set search_path = app, public, extensions;

-- 1) Clear prior demo inventory rows for both businesses' technicians (re-runnable).
delete from bracket_inventory bi
using businesses b
where bi.business_id = b.id
  and b.slug in ('handy-andy','doms');

-- Clear only the demo Walmart purchase rows we re-insert below (DEMO- prefix),
-- so we never clobber the migration-seeded order 2000149-89433822.
delete from bracket_purchases bp
using businesses b
where bp.business_id = b.id
  and b.slug in ('handy-andy','doms')
  and bp.walmart_order_num like 'DEMO-%';

-- 2) Per-tech on-hand inventory: flat / tilting / full_motion / wire_plate.
insert into bracket_inventory
  (business_id, technician_id, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty)
select b.id, tech.id, v.flat_qty, v.tilting_qty, v.full_motion_qty, v.wire_plate_qty
from (values
  ('handy-andy','Marcus Bell',  8, 5, 3, 6),
  ('handy-andy','Diego Ortiz',  6, 4, 2, 4),
  ('handy-andy','Ryan Cole',   10, 6, 4, 8),
  ('handy-andy','Tyler Fox',    4, 3, 1, 2),
  ('doms','Andre Silva',        7, 5, 3, 5),
  ('doms','Chris Nolan',        5, 3, 2, 3),
  ('doms','Priya Shah',         9, 4, 3, 6)
) as v(slug, tech_name, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty)
join businesses  b    on b.slug = v.slug
join technicians tech on tech.business_id = b.id and tech.name = v.tech_name
on conflict (business_id, technician_id) do update
  set flat_qty        = excluded.flat_qty,
      tilting_qty     = excluded.tilting_qty,
      full_motion_qty = excluded.full_motion_qty,
      wire_plate_qty  = excluded.wire_plate_qty,
      updated_at      = now();

-- Safety net: any other active tech in these businesses gets a zeroed row so the
-- dashboard never shows a missing line (mirrors api/admin.js bracketInventory()).
insert into bracket_inventory
  (business_id, technician_id, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty)
select t.business_id, t.id, 0, 0, 0, 0
from technicians t
join businesses b on b.id = t.business_id
where b.slug in ('handy-andy','doms') and t.active = true
on conflict (business_id, technician_id) do nothing;

-- 3) A few Walmart purchase rows (drive "Recent Walmart Orders", NOT on-hand counts):
--    delivered + assigned to a tech.
insert into bracket_purchases
  (business_id, technician_id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url)
select b.id, tech.id, v.ord, v.flat, v.tilt, v.fm, v.status, v.order_date, v.delivered_date, v.url
from (values
  ('handy-andy','Ryan Cole',  'DEMO-HA-1001', 4,0,0, 'delivered', date '2026-06-24', date '2026-06-28', 'https://www.walmart.com/orders/DEMO-HA-1001'),
  ('handy-andy','Marcus Bell','DEMO-HA-1002', 0,0,2, 'delivered', date '2026-06-26', date '2026-07-01', 'https://www.walmart.com/orders/DEMO-HA-1002'),
  ('doms','Andre Silva',      'DEMO-GC-2001', 3,2,0, 'delivered', date '2026-06-25', date '2026-06-29', 'https://www.walmart.com/orders/DEMO-GC-2001')
) as v(slug, tech_name, ord, flat, tilt, fm, status, order_date, delivered_date, url)
join businesses  b    on b.slug = v.slug
join technicians tech on tech.business_id = b.id and tech.name = v.tech_name;

--    ...and a couple of PENDING (unassigned, technician_id NULL) deliveries so the
--    Assign control has something to act on.
insert into bracket_purchases
  (business_id, technician_id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url)
select b.id, null, v.ord, v.flat, v.tilt, v.fm, v.status, v.order_date, v.delivered_date, v.url
from (values
  ('handy-andy','DEMO-HA-1003', 0,3,0, 'delivered', date '2026-06-30', date '2026-07-03', 'https://www.walmart.com/orders/DEMO-HA-1003'),
  ('doms',      'DEMO-GC-2002', 0,0,2, 'in_route',  date '2026-07-02', null,               'https://www.walmart.com/orders/DEMO-GC-2002')
) as v(slug, ord, flat, tilt, fm, status, order_date, delivered_date, url)
join businesses b on b.slug = v.slug;

-- ===================== website/booking analytics events =====================
-- ============================================================================
-- DEMO ANALYTICS SEED — fictional booking-funnel events for public.events.
-- Seeds ~24 days (~3.4 weeks) of sessions for BOTH booking widgets
-- ('handy-andy' = Camelback / 'doms' = Gold Coast) with realistic funnel
-- progression, drop-off, abandoned carts, failures, and conversions.
-- Idempotent + safe: every session_id is prefixed 'demo-' and all prior
-- 'demo-%' rows are deleted first, so it NEVER touches real widget events.
-- Match the exact event_type/step_name strings that api/analytics.js aggregates.
-- ============================================================================

delete from public.events where session_id like 'demo-%';

do $$
declare
  w text;
  widgets text[] := array['handy-andy','doms'];

  -- geo (per widget)
  ha_cities text[] := array['Phoenix','Scottsdale','Tempe'];
  ha_zips   text[] := array['85018','85251','85281'];
  gc_cities text[] := array['Chicago','Evanston'];
  gc_zips   text[] := array['60610','60201'];
  ha_unserved text[] := array['85142','86001','85138'];   -- out-of-area (far)
  gc_unserved text[] := array['60505','60451','60110'];
  cities text[]; zips text[]; unserved text[]; st text;

  -- traffic sources (weighted by repetition)
  ha_sources text[] := array['google','direct','google','facebook','yelp.com','bing','instagram','nextdoor.com','google','direct'];
  gc_sources text[] := array['google','direct','facebook','yelp.com','bing','google','instagram','direct','google'];
  sources text[];

  -- browsers: raw UA strings (analytics parseBrowser() derives the label)
  ua_desktop text[] := array[
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
  ];
  ua_mobile text[] := array[
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  ];

  -- names (customer_name once the checkout step is reached)
  firsts text[] := array['Emma','Liam','Olivia','Noah','Ava','Ethan','Sophia','Mason','Isabella','Lucas','Mia','Jackson','Harper','Owen','Zoe','Caleb','Lily','Aria'];
  lasts  text[] := array['Nguyen','Patel','Kim','Reyes','Bennett','Foster','Sullivan','Hughes','Chen','Meyer','Vargas','Snyder','Cross','Lane','Frost','Wade'];

  -- funnel + answer option pools
  step_keys text[]    := array['zip','frame_tv','size','bracket','fireplace','surface','wires','lifting','dismount','extras','terms','slots','customer'];
  size_labels text[]  := array['32" Or Less','33"-59"','60"-69"','70"-84"','85"-97"'];
  size_prices numeric[] := array[99,109,119,149,179];
  addon_prices numeric[] := array[0,0,25,50,75];
  bracket_opts text[] := array['I have my own bracket','Please bring a tilting mount','Please bring a full-motion mount'];
  fire_opts text[]    := array['I have 1 TV not over a fireplace','I have 1 TV above a fireplace'];
  surf_opts text[]    := array['Drywall','Brick / masonry','Concrete','Tile','Wood / plaster'];
  wire_opts text[]    := array['Yes, hide the wires BEHIND the wall','Yes, hide the wires OUTSIDE the wall','I want my wires to hang under the TV'];
  day_names text[]    := array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  cont numeric[] := array[0.70,0.88,0.88,0.90,0.90,0.88,0.90,0.90,0.90,0.88,0.82,0.75]; -- per-hop continuation

  vpool text[];                      -- returning-visitor id pool (forces repeat visitors)
  d int; n int; s int; k int;
  vid text; sid text; sess text;
  base_ts timestamptz; ev_ts timestamptz;
  dev text; ua text; src text; city text; zip text; uz text;
  reached int; sizeidx int; price numeric;
  cust text; served boolean; booked boolean;
begin
  for w in select unnest(widgets) loop
    if w = 'handy-andy' then
      cities:=ha_cities; zips:=ha_zips; unserved:=ha_unserved; sources:=ha_sources; st:='AZ';
    else
      cities:=gc_cities; zips:=gc_zips; unserved:=gc_unserved; sources:=gc_sources; st:='IL';
    end if;

    vpool := array[]::text[];
    for k in 1..18 loop vpool := vpool || ('demo-'||left(w,2)||'ret'||lpad(k::text,2,'0')); end loop;

    for d in 1..24 loop                         -- last ~3.4 weeks
      n := 8 + floor(random()*8)::int;          -- 8-15 sessions/day/widget
      for s in 1..n loop
        -- ~18% returning visitors (shared vid) → repeat-visitor analytics
        if random() < 0.18 then vid := vpool[1+floor(random()*array_length(vpool,1))::int];
        else vid := 'demo-'||left(w,2)||substr(md5(random()::text),1,8); end if;
        sid  := substr(md5(random()::text),1,8);
        sess := vid||'.'||sid;                   -- '<visitor>.<session>', all 'demo-' prefixed

        base_ts := date_trunc('day', now()) - (d||' days')::interval
                   + ((8+floor(random()*12))||' hours')::interval
                   + (floor(random()*60)||' minutes')::interval;

        if random() < 0.60 then dev:='mobile';  ua:=ua_mobile[1+floor(random()*array_length(ua_mobile,1))::int];
        else                    dev:='desktop'; ua:=ua_desktop[1+floor(random()*array_length(ua_desktop,1))::int]; end if;
        src  := sources[1+floor(random()*array_length(sources,1))::int];
        city := cities[1+floor(random()*array_length(cities,1))::int];
        zip  := zips[1+floor(random()*array_length(zips,1))::int];

        -- funnel depth via per-hop continuation (0 = only ZIP; 12 = reached checkout)
        reached := 0;
        for k in 1..12 loop exit when random() > cont[k]; reached := k; end loop;

        served := true;
        if reached = 0 and random() < 0.40 then served := false; end if;  -- out-of-area bounce

        ev_ts := base_ts;
        -- ZIP step view (mix of legacy 'page_view/zip_verify' and 'step_view/zip')
        insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
        values(sess, case when random()<0.5 then 'page_view' else 'step_view' end,
                     case when random()<0.5 then 'zip_verify' else 'zip' end,
                     0, dev, ua, src, city, st, zip, w, null, null, ev_ts);

        -- ZIP check outcome
        if served then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'zip_check','served',null,dev,ua,src,city,st,zip,w,null,null,ev_ts+interval '8 seconds');
        else
          uz := unserved[1+floor(random()*array_length(unserved,1))::int];
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'zip_check','unserved',null,dev,ua,src,city,st,uz,w,uz,null,ev_ts+interval '8 seconds');
        end if;

        -- step_view for each step reached beyond ZIP
        for k in 1..reached loop
          ev_ts := ev_ts + ((15+floor(random()*45))||' seconds')::interval;
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'step_view',step_keys[k+1],k,dev,ua,src,city,st,zip,w,null,null,ev_ts);
        end loop;

        -- per-question 'answer' events (only for steps the visitor left)
        sizeidx := 1+floor(random()*5)::int;
        if reached >= 2 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','frame_tv:'||case when random()<0.82 then 'Regular TV' else 'Frame/Gallery TV' end,1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '25 seconds');
        end if;
        if reached >= 3 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','size:'||size_labels[sizeidx],1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '55 seconds');
        end if;
        if reached >= 4 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','bracket:'||bracket_opts[1+floor(random()*array_length(bracket_opts,1))::int],1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '80 seconds');
        end if;
        if reached >= 5 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','fireplace:'||fire_opts[1+floor(random()*array_length(fire_opts,1))::int],1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '105 seconds');
        end if;
        if reached >= 6 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','surface:'||surf_opts[1+floor(random()*array_length(surf_opts,1))::int],1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '130 seconds');
        end if;
        if reached >= 7 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','wires:'||wire_opts[1+floor(random()*array_length(wire_opts,1))::int],1,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '155 seconds');
        end if;
        if reached >= 12 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'answer','slot_day:'||day_names[1+floor(random()*7)::int],null,dev,ua,src,city,st,zip,w,null,null,base_ts+interval '210 seconds');
        end if;

        -- occasional slots fetch error for deep sessions
        if reached in (11,12) and random() < 0.06 then
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'error','slots',null,dev,ua,src,city,st,zip,w,'slots fetch failed',null,ev_ts+interval '5 seconds');
        end if;

        -- Checkout: price shown, then convert / fail / abandon
        booked := false;
        if reached >= 12 then
          cust  := firsts[1+floor(random()*array_length(firsts,1))::int]||' '||lasts[1+floor(random()*array_length(lasts,1))::int];
          price := size_prices[sizeidx] + addon_prices[1+floor(random()*array_length(addon_prices,1))::int];
          ev_ts := ev_ts + interval '20 seconds';
          insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
          values(sess,'price_displayed','customer',price,dev,ua,src,city,st,zip,w,null,cust,ev_ts);

          if random() < 0.58 then                              -- ~58% of price-viewers book
            ev_ts := ev_ts + ((40+floor(random()*140))||' seconds')::interval;
            booked := true;
            insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
            values(sess,'booking_confirmed','customer',price,dev,ua,src,city,st,zip,w,null,cust,ev_ts);
          elsif random() < 0.30 then                           -- payment failure, never booked
            ev_ts := ev_ts + interval '30 seconds';
            insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
            values(sess,'booking_failed','customer',null,dev,ua,src,city,st,zip,w,'card: Your card was declined.',cust,ev_ts);
          elsif random() < 0.25 then                           -- form validation error
            insert into public.events(session_id,event_type,step_name,value,device_type,browser,traffic_source,city,state,zip_code,widget,error_message,customer_name,created_at)
            values(sess,'form_error','customer',null,dev,ua,src,city,st,zip,w,'missing phone',cust,ev_ts+interval '12 seconds');
          end if;                                              -- else: abandoned cart (saw price, no booking)
        end if;

      end loop;
    end loop;
  end loop;
end $$;

-- Verify:
--   select widget, count(distinct session_id) sessions,
--          count(*) filter (where event_type='booking_confirmed') bookings
--   from public.events where session_id like 'demo-%' group by 1;

-- ============================================================================
-- One OVERDUE, not-completed job on Jun 2 (unpaid 48h+) → glows red on schedule.
-- ============================================================================
do $$
declare bz uuid; c uuid; t uuid; s uuid; a uuid; bk uuid;
begin
  select id into bz from businesses where slug='handy-andy';
  select id into c  from customers      where business_id=bz order by random() limit 1;
  select id into t  from technicians    where business_id=bz and active=true limit 1;
  select id into s  from services        where business_id=bz limit 1;
  select id into a  from service_areas   where business_id=bz order by random() limit 1;
  -- clear any prior demo overdue job first (re-runnable)
  delete from bookings where business_id=bz and status='in_progress' and payment_status='unpaid'
    and scheduled_at::date = date '2026-06-02';
  insert into bookings (business_id, customer_id, technician_id, service_id, service_area_id,
         status, source, scheduled_at, scheduled_end, duration_minutes, subtotal, price,
         payment_status, address_line1, city, state, postal_code)
  select bz, c, t, s, a, 'in_progress'::booking_status, 'manual'::booking_source,
         timestamptz '2026-06-02 14:00-07', timestamptz '2026-06-02 15:30-07', 90, 149, 149,
         'unpaid'::payment_status, cu.address_line1, cu.city, cu.state, cu.postal_code
  from customers cu where cu.id=c
  returning id into bk;
  insert into booking_line_items (booking_id, business_id, kind, name, quantity, unit_price, line_total)
    values (bk, bz, 'service', 'TV Size: 70"-84"', 1, 149, 149);
end $$;

-- ============================================================================
-- Handyman estimate-widget analytics (5-step funnel) for the -handyman widgets.
-- Idempotent: cleaned by the 'demo-%' delete in the analytics block above.
-- ============================================================================
do $$
declare
  w text; widgets text[] := array['handy-andy-handyman','doms-handyman'];
  steps text[] := array['service','describe','photo','times','contact'];
  cont numeric[] := array[0.80,0.72,0.86,0.80];
  cities_ha text[] := array['Phoenix','Scottsdale','Tempe']; cities_gc text[] := array['Chicago','Evanston'];
  srcs text[] := array['google','direct','facebook','yelp.com','google','nextdoor.com','google','instagram'];
  firsts text[] := array['Emma','Liam','Olivia','Noah','Ava','Mason','Mia','Owen','Zoe','Caleb','Harper','Leo'];
  lasts text[] := array['Nguyen','Patel','Kim','Reyes','Chen','Meyer','Cross','Lane','Frost','Wade','Hale','Pope'];
  d int; n int; s int; k int; reached int; vid text; sess text; base_ts timestamptz; ev_ts timestamptz;
  dev text; src text; city text; st text; cust text;
begin
  for w in select unnest(widgets) loop
    if w like 'handy-andy%' then st:='AZ'; else st:='IL'; end if;
    for d in 1..21 loop
      n := 3 + floor(random()*5)::int;
      for s in 1..n loop
        vid := 'demo-'||left(replace(w,'-',''),4)||substr(md5(random()::text),1,8);
        sess := vid||'.'||substr(md5(random()::text),1,8);
        base_ts := date_trunc('day', now()) - (d||' days')::interval + ((9+floor(random()*10))||' hours')::interval;
        dev := case when random()<0.6 then 'mobile' else 'desktop' end;
        src := srcs[1+floor(random()*array_length(srcs,1))::int];
        if w like 'handy-andy%' then city:=cities_ha[1+floor(random()*3)::int]; else city:=cities_gc[1+floor(random()*2)::int]; end if;
        reached := 0; for k in 1..4 loop exit when random()>cont[k]; reached:=k; end loop;
        ev_ts := base_ts;
        insert into public.events(session_id,event_type,step_name,value,device_type,traffic_source,city,state,widget,created_at)
          values(sess,'step_view','service',0,dev,src,city,st,w,ev_ts);
        for k in 1..reached loop
          ev_ts := ev_ts + ((20+floor(random()*60))||' seconds')::interval;
          insert into public.events(session_id,event_type,step_name,value,device_type,traffic_source,city,state,widget,created_at)
            values(sess,'step_view',steps[k+1],k,dev,src,city,st,w,ev_ts);
        end loop;
        if reached>=4 then
          cust := firsts[1+floor(random()*array_length(firsts,1))::int]||' '||lasts[1+floor(random()*array_length(lasts,1))::int];
          ev_ts := ev_ts + interval '25 seconds';
          insert into public.events(session_id,event_type,step_name,value,device_type,traffic_source,city,state,widget,customer_name,created_at)
            values(sess,'price_displayed','contact',0,dev,src,city,st,w,cust,ev_ts);
          if random()<0.5 then
            insert into public.events(session_id,event_type,step_name,value,device_type,traffic_source,city,state,widget,customer_name,created_at)
              values(sess,'booking_confirmed','contact',0,dev,src,city,st,w,cust,ev_ts+interval '30 seconds');
          end if;
        end if;
      end loop;
    end loop;
  end loop;
end $$;
