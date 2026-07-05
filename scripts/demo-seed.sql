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
  addon_labels text[] := array['Soundbar installation','Hide wires behind the wall (in-wall)','Hide wires outside the wall (cord cover)','LED accent lights behind TV','Dismount & haul away old TV'];
  addon_prices numeric[] := array[50,75,25,50,35];
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
