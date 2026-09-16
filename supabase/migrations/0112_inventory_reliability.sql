-- Atomic inventory operations. This migration NEVER changes existing counts.
-- Legacy completed jobs and orders require review, not historical replay.
begin;
set search_path = app, public, extensions;

create table if not exists inventory_settings (key text primary key, value timestamptz not null);
insert into inventory_settings values ('cutover', clock_timestamp()) on conflict do nothing;
create table if not exists inventory_legacy_entities (entity_type text not null, entity_id uuid not null, primary key(entity_type, entity_id));
insert into inventory_legacy_entities select 'job', id from bookings
 where (status = 'completed' or completed_at is not null or metadata ? 'bracket_deducted_at')
 and not exists(select 1 from inventory_settings where key='legacy_snapshot') on conflict do nothing;
insert into inventory_legacy_entities select 'order', id from bracket_purchases
 where not exists(select 1 from inventory_settings where key='legacy_snapshot') on conflict do nothing;
insert into inventory_settings values('legacy_snapshot',clock_timestamp()) on conflict do nothing;
create table if not exists inventory_events (
 event_id text primary key, request jsonb not null, result jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table if not exists inventory_exceptions (
 id uuid primary key default gen_random_uuid(), entity_type text not null check(entity_type in ('job','order','stock')),
 entity_id text not null, code text not null, status text not null default 'open' check(status in ('open','resolved')),
 message text not null, evidence jsonb not null default '{}', created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(), unique(entity_type, entity_id, code)
);
create table if not exists bracket_job_allocations (
 booking_id uuid primary key references bookings(id) on delete restrict,
 technician_id uuid references technicians(id) on delete restrict,
 desired jsonb not null default '{"flat":0,"tilting":0,"full_motion":0}',
 applied jsonb not null default '{"flat":0,"tilting":0,"full_motion":0}',
 status text not null default 'recorded', revision integer not null default 0,
 effective_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
alter table bracket_inventory add column if not exists flat_verified_at timestamptz;
alter table bracket_inventory add column if not exists tilting_verified_at timestamptz;
alter table bracket_inventory add column if not exists full_motion_verified_at timestamptz;
alter table bracket_moves add column if not exists request_payload jsonb;
alter table booking_line_items add column if not exists material_type text check(material_type in ('flat','tilting','full_motion'));
alter table booking_line_items add column if not exists material_owner text check(material_owner in ('company','customer'));
alter table bracket_purchases add column if not exists received_flat_qty integer not null default 0 check(received_flat_qty>=0);
alter table bracket_purchases add column if not exists received_tilting_qty integer not null default 0 check(received_tilting_qty>=0);
alter table bracket_purchases add column if not exists received_full_motion_qty integer not null default 0 check(received_full_motion_qty>=0);
alter table bracket_purchases add column if not exists inventory_status text not null default 'unverified';
alter table bracket_purchases add column if not exists inventory_review_reason text;
alter table bracket_purchases add column if not exists last_event_at timestamptz;
alter table bracket_purchases add column if not exists order_confirmed_at timestamptz;
alter table bracket_purchases add column if not exists receipt_evidence jsonb not null default '{}';

-- New tables are server-only. PUBLIC function EXECUTE is explicitly revoked below.
do $$ declare t text; begin
 foreach t in array array['inventory_settings','inventory_legacy_entities','inventory_events','inventory_exceptions','bracket_job_allocations'] loop
   execute format('alter table app.%I enable row level security',t);
   execute format('alter table app.%I force row level security',t);
   execute format('revoke all on app.%I from public, anon, authenticated',t);
   execute format('revoke all on app.%I from service_role',t);
   execute format('grant select on app.%I to service_role',t);
 end loop;
end $$;

create or replace function inventory_qty(p_q jsonb, p_key text) returns integer
language plpgsql immutable set search_path=app,pg_temp as $$
declare n numeric;
begin
 if jsonb_typeof(p_q) is distinct from 'object' then raise exception 'inventory_invalid_quantities'; end if;
 n := coalesce((p_q->>p_key)::numeric,0);
 if n <> trunc(n) or n < 0 or n > 10000 then raise exception 'inventory_invalid_quantity: %',p_key; end if;
 return n::integer;
end $$;

create or replace function inventory_exception(p_type text,p_id text,p_code text,p_message text,p_evidence jsonb default '{}') returns void
language sql security definer set search_path=app,pg_temp as $$
 insert into inventory_exceptions(entity_type,entity_id,code,message,evidence)
 values(p_type,p_id,p_code,p_message,coalesce(p_evidence,'{}'))
 on conflict(entity_type,entity_id,code) do update set status='open',message=excluded.message,evidence=excluded.evidence,updated_at=clock_timestamp();
$$;

-- Prevent API direct writes to the three protected counters; wire/Apple-TV
-- columns remain compatible until their independent controls are migrated.
create or replace function inventory_counter_guard() returns trigger
language plpgsql set search_path=app,pg_temp as $$
begin
 if (tg_op='DELETE') or (tg_op='INSERT' and (new.flat_qty<>0 or new.tilting_qty<>0 or new.full_motion_qty<>0))
    or (tg_op='UPDATE' and (new.flat_qty,new.tilting_qty,new.full_motion_qty,new.technician_id,new.business_id,new.flat_verified_at,new.tilting_verified_at,new.full_motion_verified_at)
       is distinct from (old.flat_qty,old.tilting_qty,old.full_motion_qty,old.technician_id,old.business_id,old.flat_verified_at,old.tilting_verified_at,old.full_motion_verified_at)) then
   if current_setting('app.inventory_write',true) is distinct from 'on'
     or current_user <> (select pg_get_userbyid(proowner) from pg_proc where oid='app.bracket_move(uuid,uuid,text,integer,integer,integer,text,uuid,uuid,text,text,text)'::regprocedure)
   then raise exception 'inventory_direct_write_forbidden'; end if;
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
drop trigger if exists inventory_counter_guard on bracket_inventory;
create trigger inventory_counter_guard before insert or update or delete on bracket_inventory for each row execute function inventory_counter_guard();
create or replace function inventory_ledger_guard() returns trigger
language plpgsql set search_path=app,pg_temp as $$
begin
 if tg_op in ('UPDATE','DELETE') then raise exception 'inventory_ledger_is_append_only'; end if;
 if current_setting('app.inventory_write',true) is distinct from 'on' then raise exception 'inventory_direct_ledger_write_forbidden'; end if;
 return new;
end $$;
drop trigger if exists inventory_ledger_guard on bracket_moves;
create trigger inventory_ledger_guard before insert or update or delete on bracket_moves for each row execute function inventory_ledger_guard();
revoke insert,update,delete,truncate on bracket_moves from service_role;
revoke delete,truncate on bracket_inventory from service_role;

-- Keep the historical signature for transactional internal callers. The event
-- lock and conflict-safe row initialization cover both first-write races.
create or replace function bracket_move(p_business_id uuid,p_technician_id uuid,p_kind text,p_flat integer,p_tilting integer,p_full_motion integer,
 p_idempotency_key text,p_booking_id uuid default null,p_purchase_id uuid default null,p_order_num text default null,p_reason text default null,p_actor text default null)
returns bracket_moves language plpgsql security definer set search_path=app,pg_temp as $$
declare b uuid; inv bracket_inventory; m bracket_moves; payload jsonb; f integer; t integer; fm integer; old_flag text;
begin
 if coalesce(length(trim(p_idempotency_key)),0)=0 or length(p_idempotency_key)>400 then raise exception 'inventory_request_id_required'; end if;
 if p_kind not in ('delivery','delivery_reversal','job_use','job_reversal','adjust','recount') or p_kind is null then raise exception 'inventory_invalid_kind'; end if;
 if coalesce(length(trim(p_reason)),0)=0 then raise exception 'inventory_reason_required'; end if;
 if p_kind='recount' and current_setting('app.inventory_recount',true) is distinct from 'on' then raise exception 'inventory_recount_requires_version'; end if;
 select business_id into strict b from technicians where id=p_technician_id;
 payload:=jsonb_build_object('technician_id',p_technician_id,'kind',p_kind,'flat',p_flat,'tilting',p_tilting,'full_motion',p_full_motion,
   'booking_id',p_booking_id,'purchase_id',p_purchase_id,'order_num',p_order_num,'reason',p_reason);
 perform pg_advisory_xact_lock(hashtextextended('inventory:move:'||p_idempotency_key,0));
 select * into m from bracket_moves where idempotency_key=p_idempotency_key;
 if found then
   if m.request_payload is null or m.request_payload is distinct from payload then raise exception 'inventory_idempotency_conflict'; end if;
   return m;
 end if;
 insert into bracket_inventory(business_id,technician_id) values(b,p_technician_id) on conflict(business_id,technician_id) do nothing;
 select * into strict inv from bracket_inventory where business_id=b and technician_id=p_technician_id for update;
 if p_kind='recount' then
   if least(coalesce(p_flat,0),coalesce(p_tilting,0),coalesce(p_full_motion,0))<0 then raise exception 'inventory_invalid_count'; end if;
   f:=coalesce(p_flat,inv.flat_qty)-inv.flat_qty; t:=coalesce(p_tilting,inv.tilting_qty)-inv.tilting_qty; fm:=coalesce(p_full_motion,inv.full_motion_qty)-inv.full_motion_qty;
 else f:=coalesce(p_flat,0);t:=coalesce(p_tilting,0);fm:=coalesce(p_full_motion,0); end if;
 if greatest(abs(f),abs(t),abs(fm))>10000 then raise exception 'inventory_invalid_quantity'; end if;
 old_flag:=current_setting('app.inventory_write',true); perform set_config('app.inventory_write','on',true);
 update bracket_inventory set flat_qty=greatest(0,flat_qty+f),tilting_qty=greatest(0,tilting_qty+t),full_motion_qty=greatest(0,full_motion_qty+fm),updated_at=clock_timestamp() where id=inv.id;
 insert into bracket_moves(business_id,technician_id,kind,flat_delta,tilting_delta,full_motion_delta,clamped_flat,clamped_tilting,clamped_full_motion,
   booking_id,purchase_id,order_num,idempotency_key,reason,actor,request_payload)
 values(b,p_technician_id,p_kind,greatest(-inv.flat_qty,f),greatest(-inv.tilting_qty,t),greatest(-inv.full_motion_qty,fm),
   greatest(0,-inv.flat_qty-f),greatest(0,-inv.tilting_qty-t),greatest(0,-inv.full_motion_qty-fm),p_booking_id,p_purchase_id,p_order_num,p_idempotency_key,p_reason,p_actor,payload) returning * into m;
 perform set_config('app.inventory_write',coalesce(old_flag,''),true);
 if m.clamped_flat+m.clamped_tilting+m.clamped_full_motion>0 then
   perform inventory_exception('stock',p_technician_id::text,'stock_shortfall','Recorded use exceeds available stock; count this technician''s brackets.',to_jsonb(m));
 end if;
 return m;
end $$;

create or replace function inventory_recount(p_technician_id uuid,p_counts jsonb,p_expected_updated_at timestamptz,p_request_id text,p_reason text,p_actor text)
returns jsonb language plpgsql security definer set search_path=app,pg_temp as $$
declare inv bracket_inventory; ev inventory_events; req jsonb; result jsonb; m bracket_moves; ts timestamptz:=clock_timestamp(); k text; old_flag text;
begin
 if coalesce(trim(p_request_id),'')='' or coalesce(trim(p_reason),'')='' then raise exception 'inventory_request_and_reason_required'; end if;
 if jsonb_typeof(p_counts)<>'object' or p_counts='{}' then raise exception 'inventory_count_required'; end if;
 for k in select jsonb_object_keys(p_counts) loop
  if k not in ('flat','tilting','full_motion') then raise exception 'inventory_invalid_product'; end if;
  perform inventory_qty(p_counts,k);
 end loop;
 req:=jsonb_build_object('technician_id',p_technician_id,'counts',p_counts,'reason',p_reason);
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:recount:'||p_request_id,0));
 select * into ev from inventory_events where event_id='recount:'||p_request_id;
 if found then if ev.request<>req then raise exception 'inventory_idempotency_conflict'; end if; return ev.result||'{"duplicate":true}'; end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:initialize:'||p_technician_id::text,0));
 select bi.* into inv from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=p_technician_id for update of bi;
 if inv.id is null then
   if p_expected_updated_at is not null then raise exception 'inventory_version_conflict';end if;
   insert into bracket_inventory(business_id,technician_id) select business_id,id from technicians where id=p_technician_id
    on conflict(business_id,technician_id) do nothing returning * into inv;
   if inv.id is null then raise exception 'inventory_version_conflict';end if;
 elsif p_expected_updated_at is null or inv.updated_at<>p_expected_updated_at then raise exception 'inventory_version_conflict';end if;
 old_flag:=current_setting('app.inventory_recount',true);perform set_config('app.inventory_recount','on',true);
 m:=bracket_move(inv.business_id,p_technician_id,'recount',(p_counts->>'flat')::int,(p_counts->>'tilting')::int,(p_counts->>'full_motion')::int,'recount:'||p_request_id,null,null,null,p_reason,p_actor);
 perform set_config('app.inventory_recount',coalesce(old_flag,''),true);
 old_flag:=current_setting('app.inventory_write',true);perform set_config('app.inventory_write','on',true);
 update bracket_inventory set flat_verified_at=case when p_counts?'flat' then ts else flat_verified_at end,
   tilting_verified_at=case when p_counts?'tilting' then ts else tilting_verified_at end,
   full_motion_verified_at=case when p_counts?'full_motion' then ts else full_motion_verified_at end,updated_at=ts where id=inv.id returning * into inv;
 perform set_config('app.inventory_write',coalesce(old_flag,''),true);
 update inventory_exceptions set status='resolved',updated_at=ts where entity_type='stock' and entity_id=p_technician_id::text and code='stock_shortfall'
   and p_counts ?& array['flat','tilting','full_motion'];
 result:=jsonb_build_object('ok',true,'inventory',to_jsonb(inv),'movement',to_jsonb(m));
 insert into inventory_events values('recount:'||p_request_id,req,result,ts);return result;
end $$;

-- Source fingerprint is a normalized multiset, preserving duplicate line counts.
create or replace function inventory_material_snapshot(p_lines jsonb) returns jsonb
language sql immutable set search_path=app,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('name',coalesce(x->>'name',''),'quantity',coalesce((x->>'quantity')::numeric,1),
 'material_type',x->>'material_type','material_owner',x->>'material_owner') order by coalesce(x->>'name','') collate "C",coalesce((x->>'quantity')::numeric,1),coalesce(x->>'material_type',''),coalesce(x->>'material_owner','')),'[]'::jsonb)
 from jsonb_array_elements(p_lines) x;
$$;

drop function if exists inventory_job_write(uuid,uuid,integer,timestamptz,jsonb,jsonb,jsonb,text,text,uuid,boolean);
create or replace function inventory_job_write(p_booking_id uuid,p_business_id uuid,p_expected_li_rev integer,p_expected_updated_at timestamptz,
 p_patch jsonb,p_line_items jsonb,p_materials jsonb,p_request_id text,p_actor text,p_actor_technician_id uuid default null,p_confirm_use boolean default false,p_request_fingerprint text default null)
returns jsonb language plpgsql security definer set search_path=app,pg_temp as $$
declare b bookings; original bookings; a bracket_job_allocations; ev inventory_events; inv bracket_inventory; old_inv bracket_inventory;
 req jsonb; result jsonb; lines jsonb; q jsonb; applied jsonb; changes jsonb; issues jsonb; supplier uuid; tech uuid; k text; cols text; patch jsonb; backups jsonb; old_lines jsonb;
 m bracket_moves; reason text; status_text text:='not_used'; want_use boolean; rev integer; old_q integer; old_a integer; new_q integer; d integer; ts timestamptz:=clock_timestamp();
begin
 if coalesce(trim(p_request_id),'')='' or p_expected_li_rev is null then raise exception 'inventory_request_and_revision_required'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' or jsonb_typeof(p_materials->'source_lines') is distinct from 'array' then raise exception 'inventory_invalid_job_payload'; end if;
 patch:=p_patch-array['confirmed_at','assigned_at','on_the_way_at','arrived_at','completed_at','cancelled_at','bracket_supplied_at'];
 if patch?'metadata' then patch:=jsonb_set(patch,'{metadata}',(patch->'metadata')-array['li_rev','reopened_at','reassigned_at','bracket_deducted_at','inventory_status','inventory_issues']);end if;
 req:=jsonb_build_object('booking',p_booking_id,'business',p_business_id,'patch',patch,'lines',p_line_items,'materials',p_materials,'use',p_confirm_use,'actor_tech',p_actor_technician_id);
 if coalesce(p_request_fingerprint,'')<>'' then req:=jsonb_build_object('booking',p_booking_id,'business',p_business_id,'source_fingerprint',p_request_fingerprint,'actor_tech',p_actor_technician_id);end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:job:'||p_request_id,0));
 select * into ev from inventory_events where event_id='job:'||p_request_id;
 if found then if ev.request<>req then raise exception 'inventory_idempotency_conflict'; end if;return ev.result||'{"duplicate":true}';end if;
 select * into strict b from bookings where id=p_booking_id and business_id=p_business_id for update;
 original:=b;
 if p_actor_technician_id is not null and p_actor_technician_id is distinct from b.technician_id and p_actor_technician_id is distinct from b.secondary_technician_id then raise exception 'inventory_job_not_assigned'; end if;
 if coalesce((b.metadata->>'li_rev')::int,0)<>p_expected_li_rev or (p_expected_updated_at is not null and b.updated_at<>p_expected_updated_at) then raise exception 'inventory_job_version_conflict'; end if;
 for k in select jsonb_object_keys(p_patch) loop
   if k not in ('status','confirmed_at','assigned_at','on_the_way_at','arrived_at','completed_at','cancelled_at','cancellation_reason','technician_id','secondary_technician_id','bracket_supplied_by','bracket_supplied_at','scheduled_at','scheduled_end','extra_slots','sms_consent','metadata','address_line1','address_line2','city','state','postal_code','notes','customer_notes') then raise exception 'inventory_unsupported_booking_field: %',k; end if;
 end loop;
 patch:=p_patch; rev:=p_expected_li_rev+1;
 patch:=patch||jsonb_build_object('metadata',coalesce(b.metadata,'{}')||coalesce(p_patch->'metadata','{}')||jsonb_build_object('li_rev',rev));
 b:=jsonb_populate_record(b,patch);
 if p_line_items is not null then
   if jsonb_typeof(p_line_items)<>'array' then raise exception 'inventory_invalid_lines'; end if;
   lines:=p_line_items;
 else select coalesce(jsonb_agg(to_jsonb(li)),'[]') into lines from booking_line_items li where booking_id=b.id; end if;
 if inventory_material_snapshot(lines) is distinct from inventory_material_snapshot(p_materials->'source_lines') then raise exception 'inventory_material_snapshot_conflict'; end if;
 q:=jsonb_build_object('flat',inventory_qty(p_materials->'qtys','flat'),'tilting',inventory_qty(p_materials->'qtys','tilting'),'full_motion',inventory_qty(p_materials->'qtys','full_motion'));
 issues:=coalesce(p_materials->'issues','[]');if jsonb_typeof(issues)<>'array' then raise exception 'inventory_invalid_issues'; end if;
 select * into a from bracket_job_allocations where booking_id=b.id for update;
 want_use:=p_confirm_use or b.status='completed' or a.booking_id is not null;
 supplier:=case when p_patch?'bracket_supplied_by' then b.bracket_supplied_by
  when inventory_qty(coalesce(a.desired,'{}'),'flat')+inventory_qty(coalesce(a.desired,'{}'),'tilting')+inventory_qty(coalesce(a.desired,'{}'),'full_motion')>0 then coalesce(a.technician_id,b.bracket_supplied_by,b.technician_id)
  else coalesce(b.bracket_supplied_by,b.technician_id) end;
 if want_use then
   if jsonb_array_length(issues)>0 then reason:='ambiguous_material';
   elsif exists(select 1 from inventory_legacy_entities where entity_type='job' and entity_id=b.id) and a.booking_id is null then reason:='legacy_job_requires_review';
   elsif inventory_qty(q,'flat')+inventory_qty(q,'tilting')+inventory_qty(q,'full_motion')>0 and supplier is null then reason:='supplier_required';
   elsif (a.booking_id is null or p_patch?'bracket_supplied_by') and supplier is not null and supplier is distinct from b.technician_id and supplier is distinct from b.secondary_technician_id then reason:='supplier_not_assigned';
   elsif (a.booking_id is null or inventory_qty(a.desired,'flat')+inventory_qty(a.desired,'tilting')+inventory_qty(a.desired,'full_motion')=0)
     and b.secondary_technician_id is not null and b.bracket_supplied_by is null and inventory_qty(q,'flat')+inventory_qty(q,'tilting')+inventory_qty(q,'full_motion')>0 then reason:='supplier_required';
   end if;
   -- Lock all affected trucks in a deterministic order before paired movements.
   if reason is null then
    for tech in select distinct x from unnest(array[supplier,a.technician_id]) x where x is not null order by x loop
      insert into bracket_inventory(business_id,technician_id) select business_id,id from technicians where id=tech on conflict(business_id,technician_id) do nothing;
      perform 1 from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=tech for update of bi;
    end loop;
    select bi.* into inv from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=supplier;
    select bi.* into old_inv from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=a.technician_id;
    if a.booking_id is not null and (a.desired<>q or a.technician_id is distinct from supplier)
      and greatest(old_inv.flat_verified_at,old_inv.tilting_verified_at,old_inv.full_motion_verified_at)>a.updated_at then reason:='recount_boundary_requires_review';
    elsif a.booking_id is null and greatest(inv.flat_verified_at,inv.tilting_verified_at,inv.full_motion_verified_at)>coalesce(original.completed_at,original.scheduled_at,ts) then reason:='recount_boundary_requires_review';
    end if;
   end if;
   if reason is not null then
     status_text:='review';perform inventory_exception('job',b.id::text,reason,'Bracket usage needs office review; stock was not guessed.',jsonb_build_object('materials',p_materials,'supplier',supplier));
   else
     applied:=coalesce(a.applied,'{"flat":0,"tilting":0,"full_motion":0}'); changes:='{}';
     if a.booking_id is not null and a.technician_id is distinct from supplier and a.technician_id is not null then
       m:=bracket_move(null,a.technician_id,'job_reversal',inventory_qty(applied,'flat'),inventory_qty(applied,'tilting'),inventory_qty(applied,'full_motion'),'job:'||p_request_id||':return',b.id,null,null,'Material supplier corrected',p_actor);
       applied:='{"flat":0,"tilting":0,"full_motion":0}';
     end if;
     foreach k in array array['flat','tilting','full_motion'] loop
       old_q:=case when a.technician_id is not distinct from supplier then inventory_qty(coalesce(a.desired,'{}'),k) else 0 end;
       old_a:=inventory_qty(applied,k);new_q:=inventory_qty(q,k);
       d:=case when new_q>=old_q then -(new_q-old_q) else greatest(0,old_a-new_q) end;
       changes:=changes||jsonb_build_object(k,d);
     end loop;
     if supplier is not null and (changes->>'flat')::int<>0 or supplier is not null and (changes->>'tilting')::int<>0 or supplier is not null and (changes->>'full_motion')::int<>0 then
       m:=bracket_move(null,supplier,'job_use',(changes->>'flat')::int,(changes->>'tilting')::int,(changes->>'full_motion')::int,'job:'||p_request_id||':apply',b.id,null,null,'Reconcile physical job materials',p_actor);
       applied:=jsonb_build_object('flat',inventory_qty(applied,'flat')-m.flat_delta,'tilting',inventory_qty(applied,'tilting')-m.tilting_delta,'full_motion',inventory_qty(applied,'full_motion')-m.full_motion_delta);
     end if;
     status_text:=case when applied=q then 'recorded' else 'shortfall' end;
     if a.booking_id is null or a.desired<>q or a.technician_id is distinct from supplier then
       insert into bracket_job_allocations(booking_id,technician_id,desired,applied,status,revision,effective_at,updated_at)
        values(b.id,supplier,q,applied,status_text,1,ts,ts)
        on conflict(booking_id) do update set technician_id=excluded.technician_id,desired=excluded.desired,applied=excluded.applied,status=excluded.status,revision=bracket_job_allocations.revision+1,updated_at=ts;
     end if;
     update inventory_exceptions set status='resolved',updated_at=ts where entity_type='job' and entity_id=b.id::text;
     if status_text='shortfall' then perform inventory_exception('job',b.id::text,'stock_shortfall','Some used brackets exceeded recorded stock. Verify the technician''s physical count.',jsonb_build_object('desired',q,'applied',applied));end if;
     patch:=patch||jsonb_build_object('metadata',(patch->'metadata')||jsonb_build_object('inventory_used',true,'bracket_deducted_at',coalesce(b.metadata->>'bracket_deducted_at',ts::text)));
   end if;
 end if;
 patch:=patch||jsonb_build_object('metadata',(patch->'metadata')||jsonb_build_object('inventory_status',status_text,'inventory_issues',issues));
 if p_line_items is not null then
   select coalesce(jsonb_agg(to_jsonb(li) order by sort_order,id),'[]') into old_lines from booking_line_items li where booking_id=b.id;
   backups:=case when jsonb_typeof(original.metadata->'li_backups')='array' then original.metadata->'li_backups' else '[]'::jsonb end;
   backups:=backups||jsonb_build_array(jsonb_build_object('at',ts,'by',p_actor,'items',old_lines));
   select coalesce(jsonb_agg(x order by ord),'[]') into backups from jsonb_array_elements(backups) with ordinality as history(x,ord) where ord>jsonb_array_length(backups)-5;
   patch:=jsonb_set(patch,'{metadata,li_backups}',backups,true);
   delete from booking_line_items where booking_id=b.id;
   insert into booking_line_items(booking_id,business_id,kind,name,quantity,unit_price,line_total,taxable,sort_order,material_type,material_owner)
    select b.id,b.business_id,coalesce(x->>'kind','service')::line_item_kind,coalesce(x->>'name',''),coalesce((x->>'quantity')::numeric,1),coalesce((x->>'unit_price')::numeric,0),coalesce((x->>'line_total')::numeric,0),coalesce((x->>'taxable')::boolean,true),ord::int-1,x->>'material_type',x->>'material_owner'
    from jsonb_array_elements(p_line_items) with ordinality as a(x,ord);
   select patch||jsonb_build_object('price',coalesce(sum(line_total),0),'subtotal',coalesce(sum(case when name !~* '^\s*tax(\s|$|\()' then line_total else 0 end),0)) into patch from booking_line_items where booking_id=b.id;
 end if;
 select string_agg(format('%I = r.%I',key,key),',') into cols from jsonb_object_keys(patch) key;
 execute format('update app.bookings b set %s from jsonb_populate_record(null::app.bookings,$1) r where b.id=$2',cols) using to_jsonb(original)||patch,b.id;
 if original.status is distinct from b.status then
   insert into booking_status_events(booking_id,business_id,technician_id,status,note) values(b.id,b.business_id,p_actor_technician_id,b.status,'Updated with atomic material accounting by '||coalesce(p_actor,'office'));
 end if;
 select * into b from bookings where id=p_booking_id;
 result:=jsonb_build_object('ok',true,'li_rev',rev,'inventory_status',status_text,'issues',issues,'review_reason',reason,'qtys',q,'applied',applied,'price',b.price,'subtotal',b.subtotal,'updated_at',b.updated_at);
 insert into inventory_events values('job:'||p_request_id,req,result,ts);return result;
end $$;

create or replace function ingest_bracket_order(p_order_num text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=app,pg_temp as $$
declare p bracket_purchases; prior bracket_purchases; ev inventory_events; req jsonb; result jsonb; received jsonb; ordered jsonb; inv bracket_inventory;
 event_key text; issue text; incoming_status text; supplier uuid; occurred timestamptz; cutover timestamptz; n integer; k text; m bracket_moves;
 ts timestamptz:=clock_timestamp(); legacy boolean; verified boolean; facts_verified boolean; stale boolean; df integer;dt integer;dm integer;
begin
 if coalesce(trim(p_order_num),'')='' or coalesce(trim(p_payload->>'event_id'),'')='' then raise exception 'inventory_order_event_required';end if;
 event_key:='order:'||(p_payload->>'event_id');
 if p_payload->>'source'='walmart_email' and coalesce(p_payload->>'source_fingerprint','')<>'' then
   req:=jsonb_build_object('order_num',trim(p_order_num),'source_fingerprint',p_payload->>'source_fingerprint');
 else req:=jsonb_build_object('order_num',trim(p_order_num),'payload',case when p_payload->>'source'='manual' then p_payload-array['occurred_at','expected_updated_at'] else p_payload end);end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:'||event_key,0));
 select * into ev from inventory_events where event_id=event_key;
 if found then
   if ev.request<>req then raise exception 'inventory_idempotency_conflict';end if;
   return ev.result||jsonb_build_object('duplicate',true,'review_pending',exists(select 1 from inventory_exceptions where entity_type='order' and status='open' and entity_id in (ev.result->>'purchase_id',p_order_num)));
 end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:order:'||lower(trim(p_order_num)),0));
 select count(*) into n from bracket_purchases where lower(trim(walmart_order_num))=lower(trim(p_order_num));
 if n>1 then
  perform inventory_exception('order',p_order_num,'duplicate_order_rows','Multiple records share this order number. Review before crediting.',p_payload);
  result:=jsonb_build_object('ok',true,'status','review','inventory_status','review','review_reason','duplicate_order_rows');
  insert into inventory_events values(event_key,req,result,ts);return result;
 end if;
 select * into p from bracket_purchases where lower(trim(walmart_order_num))=lower(trim(p_order_num)) for update;
 if p_payload->>'source'='manual' then
  if p_payload->>'expected_absent'='true' and p.id is not null then raise exception 'inventory_order_version_conflict';end if;
  if p_payload->>'expected_updated_at' is not null and (p.id is null or p.updated_at is distinct from (p_payload->>'expected_updated_at')::timestamptz) then raise exception 'inventory_order_version_conflict';end if;
 end if;
 supplier:=(nullif(p_payload->>'technician_id',''))::uuid;
 if supplier is not null and not exists(select 1 from technicians where id=supplier) then raise exception 'inventory_unknown_technician';end if;
 if p.id is null then
   insert into bracket_purchases(business_id,technician_id,walmart_order_num,status)
    values(coalesce((select business_id from technicians where id=supplier),(p_payload->>'business_id')::uuid),supplier,trim(p_order_num),'ordered') returning * into p;
 end if;
 prior:=p;
 facts_verified:=p_payload->>'source'='manual' or coalesce((p_payload->>'facts_verified')::boolean,false);
 if not coalesce(facts_verified,false) then
   issue:=coalesce(nullif(p_payload->>'review_reason',''),'source_facts_unverified');
   perform inventory_exception('order',p.id::text,issue,'Supplier evidence needs review; order facts and stock were preserved.',p_payload);
   update bracket_purchases set inventory_status='review',inventory_review_reason=issue where id=p.id;
   result:=jsonb_build_object('ok',true,'status','review','purchase_id',p.id,'review_reason',issue,'inventory_status','review');
   insert into inventory_events values(event_key,req,result,ts);return result;
 end if;
 legacy:=exists(select 1 from inventory_legacy_entities where entity_type='order' and entity_id=p.id);
 select value into cutover from inventory_settings where key='cutover';
 occurred:=(nullif(p_payload->>'occurred_at',''))::timestamptz;
 if p_payload->>'source'='walmart_email' and (occurred is null or occurred>ts+interval '5 minutes') then
  issue:='source_date_invalid';perform inventory_exception('order',p.id::text,issue,'Supplier event time is missing or in the future; order facts were preserved.',p_payload);
  update bracket_purchases set inventory_status='review',inventory_review_reason=issue where id=p.id;
  result:=jsonb_build_object('ok',true,'status','review','purchase_id',p.id,'review_reason',issue,'inventory_status','review');
  insert into inventory_events values(event_key,req,result,ts);return result;
 end if;
 incoming_status:=coalesce(p_payload->>'status',p.status);
 if incoming_status not in ('ordered','in_route','delivered','canceled') then raise exception 'inventory_invalid_order_status';end if;
 issue:=nullif(p_payload->>'review_reason','');
 ordered:=p_payload->'ordered';
 stale:=p.last_event_at is not null and occurred is not null and occurred<p.last_event_at;
 if stale and (ordered is null or ordered='null'::jsonb or (p.order_confirmed_at is not null and p.order_confirmed_at>=occurred)) then
   result:=jsonb_build_object('ok',true,'status',case when p.inventory_status='review' then 'review' else 'synced' end,'purchase_id',p.id,'inventory_status',p.inventory_status,'review_reason',p.inventory_review_reason,'ignored_stale',true);
   insert into inventory_events values(event_key,req,result,ts);return result;
 end if;
 if supplier is not null and supplier is distinct from p.technician_id and p.receipt_evidence->>'recipient_override'='true' then issue:='recipient_conflicts_with_reviewed_assignment';
 elsif supplier is not null and supplier is distinct from p.technician_id and p.received_flat_qty+p.received_tilting_qty+p.received_full_motion_qty>0 then issue:='delivered_supplier_change_requires_review';
 elsif supplier is not null and not legacy then p.technician_id:=supplier;end if;
 if ordered is not null and ordered<>'null'::jsonb and (p.order_confirmed_at is null or occurred is null or occurred>=p.order_confirmed_at) then
   p.flat_qty:=inventory_qty(ordered,'flat');p.tilting_qty:=inventory_qty(ordered,'tilting');p.full_motion_qty:=inventory_qty(ordered,'full_motion');
   if p.flat_qty<p.received_flat_qty or p.tilting_qty<p.received_tilting_qty or p.full_motion_qty<p.received_full_motion_qty then
    issue:=coalesce(issue,'confirmed_less_than_received');p.flat_qty:=prior.flat_qty;p.tilting_qty:=prior.tilting_qty;p.full_motion_qty:=prior.full_motion_qty;
   else p.order_confirmed_at:=coalesce(occurred,ts);end if;
 end if;
 p.order_date:=coalesce((nullif(p_payload->>'order_date',''))::date,p.order_date);
 p.delivered_date:=coalesce((nullif(p_payload->>'delivered_date',''))::date,p.delivered_date);
 p.estimated_delivery:=coalesce((nullif(p_payload->>'estimated_delivery',''))::date,p.estimated_delivery);
 p.order_url:=coalesce(nullif(p_payload->>'order_url',''),p.order_url);
 p.order_total:=coalesce((nullif(p_payload->>'order_total',''))::numeric,p.order_total);
 received:=p_payload->'received'; verified:=coalesce((p_payload->>'receipt_verified')::boolean,false) and p_payload->>'receipt_scope' in ('complete','cumulative');
 if p.status='canceled' and incoming_status<>'canceled' then issue:=coalesce(issue,'canceled_order_state_conflict'); incoming_status:='canceled';end if;
 if verified and p_payload->>'receipt_scope'='complete' and (received is null or received='null'::jsonb) and p.flat_qty+p.tilting_qty+p.full_motion_qty>0 then
   received:=jsonb_build_object('flat',p.flat_qty,'tilting',p.tilting_qty,'full_motion',p.full_motion_qty);
 end if;
 if incoming_status='delivered' or (received is not null and received<>'null'::jsonb) then
   if not verified or received is null or received='null'::jsonb then issue:=coalesce(issue,'receipt_quantities_unverified');
   elsif legacy then issue:=coalesce(issue,'legacy_receipt_requires_review');
   elsif occurred is null or occurred<cutover then issue:=coalesce(issue,'historical_receipt_requires_review');
   elsif p.technician_id is null then issue:=coalesce(issue,'recipient_unassigned');
   end if;
   if received is not null and received<>'null'::jsonb then
     df:=inventory_qty(received,'flat')-p.received_flat_qty;dt:=inventory_qty(received,'tilting')-p.received_tilting_qty;dm:=inventory_qty(received,'full_motion')-p.received_full_motion_qty;
     if least(df,dt,dm)<0 then issue:=coalesce(issue,'received_quantity_regression');end if;
     if inventory_qty(received,'flat')>p.flat_qty or inventory_qty(received,'tilting')>p.tilting_qty or inventory_qty(received,'full_motion')>p.full_motion_qty then issue:=coalesce(issue,'received_exceeds_ordered');end if;
   end if;
   if issue is null then
     insert into bracket_inventory(business_id,technician_id) select business_id,id from technicians where id=p.technician_id on conflict(business_id,technician_id) do nothing;
     select bi.* into strict inv from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=p.technician_id for update of bi;
     if (df<>0 and inv.flat_verified_at>=occurred) or(dt<>0 and inv.tilting_verified_at>=occurred) or(dm<>0 and inv.full_motion_verified_at>=occurred) then issue:='recount_boundary_requires_review';end if;
   end if;
   if issue is null then
     if df+dt+dm>0 then m:=bracket_move(null,p.technician_id,'delivery',df,dt,dm,event_key||':receipt',null,p.id,p_order_num,'Verified cumulative receipt',coalesce(p_payload->>'actor',p_payload->>'source','email'));end if;
     p.received_flat_qty:=inventory_qty(received,'flat');p.received_tilting_qty:=inventory_qty(received,'tilting');p.received_full_motion_qty:=inventory_qty(received,'full_motion');
     p.receipt_evidence:=coalesce(p.receipt_evidence,'{}')||coalesce(p_payload->'evidence','{}')||jsonb_build_object('event_id',p_payload->>'event_id','occurred_at',occurred,'scope',p_payload->>'receipt_scope');
     p.inventory_status:='recorded';
   end if;
 end if;
 if incoming_status='canceled' then
   if p_payload->>'source'='manual' and p_payload->>'cancel_unreceived_remainder'='true' then
     p.receipt_evidence:=coalesce(p.receipt_evidence,'{}')||jsonb_build_object('remainder_canceled',true,'canceled_event_id',p_payload->>'event_id');
     p.inventory_status:='recorded';
   elsif p.received_flat_qty+p.received_tilting_qty+p.received_full_motion_qty>0 then issue:=coalesce(issue,'canceled_received_order_requires_review');
   elsif legacy then issue:=coalesce(issue,'legacy_cancellation_requires_review');
   else p.inventory_status:='recorded';end if;
 end if;
 if p.status='delivered' and incoming_status in ('ordered','in_route') then incoming_status:=p.status;end if;
 if issue is not null then
   incoming_status:=prior.status;
   p.inventory_status:='review';perform inventory_exception('order',p.id::text,issue,'Order needs review before stock can change.',p_payload);
 elsif p.inventory_status='recorded' then update inventory_exceptions set status='resolved',updated_at=ts where entity_type='order' and entity_id=p.id::text;end if;
  update bracket_purchases set technician_id=p.technician_id,flat_qty=p.flat_qty,tilting_qty=p.tilting_qty,full_motion_qty=p.full_motion_qty,status=case when stale then prior.status else incoming_status end,
  order_date=p.order_date,delivered_date=p.delivered_date,estimated_delivery=p.estimated_delivery,order_url=p.order_url,order_total=p.order_total,
  received_flat_qty=p.received_flat_qty,received_tilting_qty=p.received_tilting_qty,received_full_motion_qty=p.received_full_motion_qty,
   inventory_status=p.inventory_status,inventory_review_reason=issue,last_event_at=case when issue is null then greatest(occurred,p.last_event_at) else p.last_event_at end,order_confirmed_at=p.order_confirmed_at,receipt_evidence=p.receipt_evidence where id=p.id;
 -- Keep the immutable source time with the event result: a fingerprint-only
 -- request intentionally omits mutable recipient resolution and source details.
 -- Transfer/reassignment checks must compare physical recounts to receipt time,
 -- never to the later email scan or ledger insertion time.
 result:=jsonb_build_object('ok',true,'status',case when issue is null then 'synced' else 'review' end,'purchase_id',p.id,'review_reason',issue,'inventory_status',p.inventory_status,'receipt_occurred_at',occurred);
 insert into inventory_events values(event_key,req,result,ts);return result;
end $$;

-- All security-definer entry points are private to the application server.
revoke all on function bracket_move(uuid,uuid,text,integer,integer,integer,text,uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function inventory_recount(uuid,jsonb,timestamptz,text,text,text) from public,anon,authenticated;
revoke all on function inventory_job_write(uuid,uuid,integer,timestamptz,jsonb,jsonb,jsonb,text,text,uuid,boolean,text) from public,anon,authenticated;
revoke all on function ingest_bracket_order(text,jsonb) from public,anon,authenticated;
revoke all on function inventory_exception(text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function inventory_qty(jsonb,text),inventory_material_snapshot(jsonb),inventory_counter_guard(),inventory_ledger_guard() from public,anon,authenticated;
grant execute on function bracket_move(uuid,uuid,text,integer,integer,integer,text,uuid,uuid,text,text,text),inventory_recount(uuid,jsonb,timestamptz,text,text,text),
 inventory_job_write(uuid,uuid,integer,timestamptz,jsonb,jsonb,jsonb,text,text,uuid,boolean,text),ingest_bracket_order(text,jsonb),inventory_exception(text,text,text,text,jsonb),inventory_qty(jsonb,text) to service_role;
commit;
