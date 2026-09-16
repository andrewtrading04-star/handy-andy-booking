-- Physical transfers and recipient corrections. No existing stock is reset.
begin;
set search_path=app,public,extensions;

-- Private helper: lock both home-business stock accounts in the same order,
-- validate the whole debit, then write the paired movements in one transaction.
create or replace function inventory_move_between(
 p_from uuid,p_to uuid,p_q jsonb,p_key text,p_reason text,p_actor text,
 p_purchase_id uuid default null,p_order_num text default null,p_receipt_cutoffs jsonb default null)
returns jsonb language plpgsql security definer set search_path=app,pg_temp as $$
declare stock_tech_id uuid; src bracket_inventory; dst bracket_inventory; out_move bracket_moves; in_move bracket_moves;
 f integer; ti integer; fm integer; cutoff timestamptz;
begin
 if p_from is null or p_to is null or p_from=p_to then raise exception 'inventory_distinct_technicians_required';end if;
 f:=inventory_qty(p_q,'flat');ti:=inventory_qty(p_q,'tilting');fm:=inventory_qty(p_q,'full_motion');
 if f+ti+fm=0 then raise exception 'inventory_positive_transfer_required';end if;
 if not exists(select 1 from technicians where id=p_from)
  or not exists(select 1 from technicians t where id=p_to and coalesce((to_jsonb(t)->>'active')::boolean,true))
 then raise exception 'inventory_unknown_or_inactive_recipient';end if;
 for stock_tech_id in select x from unnest(array[p_from,p_to]) x order by x loop
  insert into bracket_inventory(business_id,technician_id)
   select business_id,id from technicians where id=stock_tech_id on conflict(business_id,technician_id) do nothing;
  perform 1 from bracket_inventory bi join technicians tech on tech.id=bi.technician_id and tech.business_id=bi.business_id
   where bi.technician_id=stock_tech_id for update of bi;
 end loop;
 select bi.* into strict src from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=p_from;
 select bi.* into strict dst from bracket_inventory bi join technicians t on t.id=bi.technician_id and t.business_id=bi.business_id where bi.technician_id=p_to;
 if p_receipt_cutoffs is not null then
  if f>0 then
   cutoff:=(p_receipt_cutoffs->>'flat')::timestamptz;
   if cutoff is null or src.flat_verified_at>=cutoff or dst.flat_verified_at>=cutoff then raise exception using errcode='PIV01',message='inventory_reassignment_crosses_physical_count';end if;
  end if;
  if ti>0 then
   cutoff:=(p_receipt_cutoffs->>'tilting')::timestamptz;
   if cutoff is null or src.tilting_verified_at>=cutoff or dst.tilting_verified_at>=cutoff then raise exception using errcode='PIV01',message='inventory_reassignment_crosses_physical_count';end if;
  end if;
  if fm>0 then
   cutoff:=(p_receipt_cutoffs->>'full_motion')::timestamptz;
   if cutoff is null or src.full_motion_verified_at>=cutoff or dst.full_motion_verified_at>=cutoff then raise exception using errcode='PIV01',message='inventory_reassignment_crosses_physical_count';end if;
  end if;
 end if;
 if src.flat_qty<f or src.tilting_qty<ti or src.full_motion_qty<fm then
  raise exception using errcode='PIV02',message='inventory_insufficient_transfer_stock';
 end if;
 out_move:=bracket_move(null,p_from,'adjust',-f,-ti,-fm,p_key||':out',null,p_purchase_id,p_order_num,p_reason||' (out)',p_actor);
 in_move:=bracket_move(null,p_to,'adjust',f,ti,fm,p_key||':in',null,p_purchase_id,p_order_num,p_reason||' (in)',p_actor);
 if out_move.clamped_flat+out_move.clamped_tilting+out_move.clamped_full_motion>0 then raise exception 'inventory_transfer_must_not_clamp';end if;
 return jsonb_build_object('from_movement',out_move.id,'to_movement',in_move.id,'quantities',p_q);
end $$;

create or replace function inventory_transfer(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=app,pg_temp as $$
declare ev inventory_events; req jsonb; result jsonb; q jsonb; from_id uuid; to_id uuid; event_key text; reason text; k text;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'inventory_invalid_transfer_payload';end if;
 if coalesce(length(trim(p_payload->>'event_id')),0)=0 or length(p_payload->>'event_id')>300 then raise exception 'inventory_request_id_required';end if;
 reason:=trim(p_payload->>'reason');if coalesce(length(reason),0)<8 then raise exception 'inventory_meaningful_reason_required';end if;
 from_id:=(p_payload->>'from_technician_id')::uuid;to_id:=(p_payload->>'to_technician_id')::uuid;
 if jsonb_typeof(p_payload->'quantities') is distinct from 'object' then raise exception 'inventory_invalid_quantities';end if;
 for k in select jsonb_object_keys(p_payload->'quantities') loop if k not in ('flat','tilting','full_motion') then raise exception 'inventory_invalid_product';end if;end loop;
 q:=jsonb_build_object('flat',inventory_qty(p_payload->'quantities','flat'),'tilting',inventory_qty(p_payload->'quantities','tilting'),'full_motion',inventory_qty(p_payload->'quantities','full_motion'));
 req:=jsonb_build_object('from',from_id,'to',to_id,'quantities',q,'reason',reason);
 event_key:='transfer:'||(p_payload->>'event_id');
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:'||event_key,0));
 select * into ev from inventory_events where event_id=event_key;
 if found then if ev.request is distinct from req then raise exception 'inventory_idempotency_conflict';end if;return ev.result||'{"duplicate":true}';end if;
 result:=inventory_move_between(from_id,to_id,q,event_key,'Physical transfer: '||reason,coalesce(p_payload->>'actor','office'))||jsonb_build_object('ok',true,'inventory_status','recorded');
 insert into inventory_events(event_id,request,result) values(event_key,req,result);
 return result;
end $$;

create or replace function inventory_reassign(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=app,pg_temp as $$
declare ev inventory_events; p bracket_purchases; req jsonb; result jsonb; q jsonb; net jsonb; cutoffs jsonb;
 purchase_id uuid; target uuid; event_key text; reason text; issue text; order_number text; recipient_name text; n integer; total integer;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'inventory_invalid_reassignment_payload';end if;
 if coalesce(length(trim(p_payload->>'event_id')),0)=0 or length(p_payload->>'event_id')>300 then raise exception 'inventory_request_id_required';end if;
 reason:=trim(p_payload->>'reason');if coalesce(length(reason),0)<8 then raise exception 'inventory_meaningful_reason_required';end if;
 purchase_id:=(p_payload->>'purchase_id')::uuid;target:=(p_payload->>'technician_id')::uuid;
 req:=jsonb_build_object('purchase_id',purchase_id,'technician_id',target,'expected_updated_at',p_payload->>'expected_updated_at','reason',reason);
 event_key:='reassign:'||(p_payload->>'event_id');
 perform pg_advisory_xact_lock(hashtextextended('inventory:event:'||event_key,0));
 select * into ev from inventory_events where event_id=event_key;
 if found then if ev.request is distinct from req then raise exception 'inventory_idempotency_conflict';end if;return ev.result||'{"duplicate":true}';end if;
 select walmart_order_num into strict order_number from bracket_purchases where id=purchase_id;
 -- Match the ingestion lock order: order identity first, then purchase row.
 perform pg_advisory_xact_lock(hashtextextended('inventory:order:'||lower(trim(coalesce(order_number,purchase_id::text))),0));
 select * into strict p from bracket_purchases where id=purchase_id for update;
 if nullif(p_payload->>'expected_updated_at','') is not null and p.updated_at<>(p_payload->>'expected_updated_at')::timestamptz then raise exception 'inventory_version_conflict';end if;
 select name into recipient_name from technicians t where id=target and coalesce((to_jsonb(t)->>'active')::boolean,true);
 if not found then raise exception 'inventory_unknown_or_inactive_recipient';end if;
 if target is not distinct from p.technician_id then raise exception 'inventory_recipient_unchanged';end if;
 if lower(p.status) in ('canceled','cancelled','returned') then raise exception 'inventory_closed_order_cannot_assign';end if;
 q:=jsonb_build_object('flat',p.received_flat_qty,'tilting',p.received_tilting_qty,'full_motion',p.received_full_motion_qty);
 total:=p.received_flat_qty+p.received_tilting_qty+p.received_full_motion_qty;
 select count(*) into n from bracket_purchases where lower(trim(walmart_order_num))=lower(trim(order_number));
 if n>1 then issue:='duplicate_order_rows';
 elsif exists(select 1 from inventory_legacy_entities where entity_type='order' and entity_id=p.id)
  and (total>0 or p.status='delivered' or p.inventory_status='review') then issue:='legacy_recipient_requires_review';
 elsif total>0 and (p.technician_id is null or p.inventory_status<>'recorded') then issue:='unverified_receipt_allocation';
 end if;
 if total>0 and issue is null then
  -- Received totals alone do not prove which truck was actually credited.
  select jsonb_build_object('flat',coalesce(sum(flat_delta),0),'tilting',coalesce(sum(tilting_delta),0),'full_motion',coalesce(sum(full_motion_delta),0))
   into net from bracket_moves where bracket_moves.purchase_id=p.id and technician_id=p.technician_id;
  if net is distinct from q then issue:='receipt_allocation_mismatch';end if;
  -- A late email can be processed AFTER the destination's physical count even
  -- though the physical delivery happened BEFORE it. Use the original receipt
  -- event time, not scan/movement creation time, to protect that count.
  select jsonb_build_object(
   'flat',case when count(*) filter(where m.flat_delta>0 and nullif(e.result->>'receipt_occurred_at','') is null)>0 then null else min((e.result->>'receipt_occurred_at')::timestamptz) filter(where m.flat_delta>0) end,
   'tilting',case when count(*) filter(where m.tilting_delta>0 and nullif(e.result->>'receipt_occurred_at','') is null)>0 then null else min((e.result->>'receipt_occurred_at')::timestamptz) filter(where m.tilting_delta>0) end,
   'full_motion',case when count(*) filter(where m.full_motion_delta>0 and nullif(e.result->>'receipt_occurred_at','') is null)>0 then null else min((e.result->>'receipt_occurred_at')::timestamptz) filter(where m.full_motion_delta>0) end)
   into cutoffs from bracket_moves m left join inventory_events e on e.event_id=regexp_replace(m.idempotency_key,':receipt$','')
   where m.purchase_id=p.id and m.kind='delivery';
  if issue is null then
   begin
    result:=inventory_move_between(p.technician_id,target,q,event_key,'Order recipient correction: '||reason,coalesce(p_payload->>'actor','office'),p.id,p.walmart_order_num,cutoffs);
   exception when sqlstate 'PIV01' then issue:='recount_boundary_requires_review';
    when sqlstate 'PIV02' then issue:='insufficient_stock_for_recipient_correction';
   end;
  end if;
 end if;
 if issue is not null then
  perform inventory_exception('order',p.id::text,issue,'Recipient correction needs review. No stock or assignment was changed.',p_payload);
  result:=jsonb_build_object('ok',true,'status','review','inventory_status','review','review_reason',issue,'purchase_id',p.id);
 else
  update bracket_purchases set technician_id=target,
   receipt_evidence=coalesce(receipt_evidence,'{}')||jsonb_build_object('recipient_override',true,'recipient_corrected_at',clock_timestamp(),'recipient_reason',reason,'recipient_actor',coalesce(p_payload->>'actor','office')),
   updated_at=clock_timestamp() where id=p.id;
  update inventory_exceptions set status='resolved',updated_at=clock_timestamp() where entity_type='order' and entity_id=p.id::text
   and code in ('recipient_unassigned','delivered_supplier_change_requires_review','unverified_receipt_allocation','receipt_allocation_mismatch','insufficient_stock_for_recipient_correction');
  result:=coalesce(result,'{}')||jsonb_build_object('ok',true,'status','synced','inventory_status',case when total>0 then 'recorded' else 'unreceived' end,
   'purchase_id',p.id,'technician_id',target,'technician_name',recipient_name,'moved_quantities',q);
 end if;
 insert into inventory_events(event_id,request,result) values(event_key,req,result);return result;
end $$;

revoke all on function inventory_move_between(uuid,uuid,jsonb,text,text,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
revoke all on function inventory_transfer(jsonb),inventory_reassign(jsonb) from public,anon,authenticated;
grant execute on function inventory_transfer(jsonb),inventory_reassign(jsonb) to service_role;
commit;
