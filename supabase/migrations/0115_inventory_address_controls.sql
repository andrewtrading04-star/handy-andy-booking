-- Versioned, replay-safe managed supplier addresses. No existing mapping is
-- changed by this migration. Only the owner's server endpoint can execute it.
begin;
set search_path=app,public,extensions;
create or replace function inventory_normalize_shipping_address(p_address text) returns text
language sql immutable set search_path=app,pg_temp as $$
 select trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
 lower(normalize(coalesce(p_address,''),NFKC)),
 '\m(united states( of america)?|usa)\M','','g'),
 '\m([0-9]{5})-[0-9]{4}\M','\1','g'),'[.,]',' ','g'),'[[:space:]]+',' ','g'));
$$;

create or replace function inventory_shipping_address_save(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=app,pg_temp as $$
declare existing bracket_shipping_addresses; saved bracket_shipping_addresses; ev inventory_events;
 key text; normalized text; raw_address text; tech uuid; target uuid; req jsonb; result jsonb; enabled boolean; expected timestamptz;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'inventory_invalid_address_payload';end if;
 if coalesce(length(trim(p_payload->>'event_id')),0)=0 or length(p_payload->>'event_id')>250 then raise exception 'inventory_address_request_id_required';end if;
 raw_address:=trim(p_payload->>'address');
 if raw_address is null or length(raw_address)>400 or raw_address !~ '^[0-9]{1,6}[[:space:]]+[A-Za-z]' or raw_address !~* '\m[A-Z]{2}[[:space:]]*,?[[:space:]]*[0-9]{5}(-[0-9]{4})?\M' then raise exception 'inventory_complete_shipping_address_required';end if;
 if regexp_replace(raw_address,E'\\r?\\n',', ','g') !~* $re$,[[:space:]]*[A-Za-z .'-]{2,40},?[[:space:]]+[A-Z]{2}[[:space:]]*,?[[:space:]]*[0-9]{5}(-[0-9]{4})?\M$re$ then raise exception 'inventory_shipping_city_required';end if;
 normalized:=inventory_normalize_shipping_address(raw_address);
 if normalized is distinct from p_payload->>'normalized_address' then raise exception 'inventory_address_normalization_conflict';end if;
 if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception 'inventory_invalid_address_active';end if;
 enabled:=(p_payload->>'active')::boolean;
 target:=(nullif(p_payload->>'id',''))::uuid;tech:=(nullif(p_payload->>'technician_id',''))::uuid;
 expected:=(nullif(p_payload->>'expected_updated_at',''))::timestamptz;
 req:=jsonb_build_object('id',target,'technician_id',tech,'address',raw_address,'normalized_address',normalized,'active',enabled,'expected_updated_at',expected,'actor',p_payload->>'actor');
 key:='shipping-address:'||(p_payload->>'event_id');
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:'||key,0));
 select * into ev from inventory_events where event_id=key;
 if found then if ev.request is distinct from req then raise exception 'inventory_idempotency_conflict';end if;return ev.result||'{"duplicate":true}';end if;
 if not exists(select 1 from technicians t where id=tech and coalesce((to_jsonb(t)->>'active')::boolean,true)) then raise exception 'inventory_active_technician_required';end if;
 perform pg_advisory_xact_lock(hashtextextended('inventory:shipping-address:'||normalized,0));
 if target is null then
   select * into existing from bracket_shipping_addresses where normalized_address=normalized for update;
   if found then
     if existing.technician_id is distinct from tech then raise exception 'inventory_address_already_assigned_conflict';end if;
     if existing.address is distinct from raw_address or existing.active is distinct from enabled then raise exception 'inventory_address_version_required';end if;
     saved:=existing;
   else
     insert into bracket_shipping_addresses(technician_id,address,normalized_address,active) values(tech,raw_address,normalized,enabled) returning * into saved;
   end if;
 else
   if expected is null then raise exception 'inventory_address_version_required';end if;
   select * into existing from bracket_shipping_addresses where id=target for update;
   if not found then raise exception 'inventory_address_not_found';end if;
   if existing.updated_at is distinct from expected then raise exception 'inventory_address_version_conflict';end if;
   if exists(select 1 from bracket_shipping_addresses where normalized_address=normalized and id<>target) then raise exception 'inventory_address_already_assigned_conflict';end if;
   update bracket_shipping_addresses set technician_id=tech,address=raw_address,normalized_address=normalized,active=enabled where id=target returning * into saved;
 end if;
 result:=jsonb_build_object('ok',true,'id',saved.id,'address',to_jsonb(saved));
 insert into inventory_events(event_id,request,result) values(key,req,result);return result;
end $$;
revoke all on function inventory_shipping_address_save(jsonb),inventory_normalize_shipping_address(text) from public,anon,authenticated;
grant execute on function inventory_shipping_address_save(jsonb),inventory_normalize_shipping_address(text) to service_role;
-- Every address mutation uses the versioned operation; application reads remain.
revoke insert,update,delete on bracket_shipping_addresses from service_role;
commit;
