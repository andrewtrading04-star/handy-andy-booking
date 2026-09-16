import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createInventoryTestDb,ids,supabaseFor} from './lib/inventory-test-db.mjs';
import {recount,syncBracketOrder} from '../api/_lib/bracket-moves.js';

const quantities=(flat=0,tilting=0,full_motion=0)=>({flat,tilting,full_motion});
async function database(){const db=await createInventoryTestDb();await db.exec(await readFile(new URL('../supabase/migrations/0114_inventory_controls.sql',import.meta.url),'utf8'));return db;}
async function stock(db,id){return (await db.query('select *,updated_at::text version from app.bracket_inventory where technician_id=$1',[id])).rows[0];}
async function seed(db,id,flat=5,tilting=2,full_motion=1){await db.query("select app.bracket_move(null,$1,'adjust',$2,$3,$4,$5,null,null,null,'Test opening stock','test')",[id,flat,tilting,full_motion,randomUUID()]);}
async function rpc(db,name,payload){return (await db.query(`select app.${name}($1::jsonb) result`,[payload])).rows[0].result;}
function transfer(from=ids.a,to=ids.b,q=quantities(2)){return {from_technician_id:from,to_technician_id:to,quantities:q,event_id:randomUUID(),reason:'Technicians handed over stock',actor:'test'};}
function reassign(purchase,to=ids.b){return {purchase_id:purchase,technician_id:to,event_id:randomUUID(),reason:'Correct verified delivery recipient',actor:'test'};}
async function receivedOrder(db,q=quantities(3),occurredOverride=null){
 const occurred=occurredOverride||(await db.query('select clock_timestamp()::text at')).rows[0].at;
 const r=await syncBracketOrder(supabaseFor(db),{orderNum:'test-'+randomUUID(),event_id:randomUUID(),technician_id:ids.a,business_id:ids.business,status:'delivered',ordered:q,received:q,receipt_scope:'cumulative',receipt_verified:true,source:'manual',occurred_at:occurred,actor:'test'});
 assert.equal(r.inventory_status,'recorded');return r.purchase_id;
}

test('real SQL: physical transfer is paired, cross-business and replay-safe',async()=>{
 const db=await database();try{
  await seed(db,ids.a);await seed(db,ids.b,1,0,0);const payload=transfer(ids.a,ids.b,quantities(2,1));
  const first=await rpc(db,'inventory_transfer',payload);assert.equal(first.inventory_status,'recorded');
  assert.equal((await stock(db,ids.a)).flat_qty,3);assert.equal((await stock(db,ids.b)).flat_qty,3);assert.equal((await stock(db,ids.b)).business_id,ids.otherBusiness);
  assert.equal((await rpc(db,'inventory_transfer',payload)).duplicate,true);assert.equal((await stock(db,ids.b)).tilting_qty,1);
  await assert.rejects(rpc(db,'inventory_transfer',{...payload,quantities:quantities(3)}),/idempotency_conflict/);
  assert.equal((await db.query('select sum(flat_qty)::int n from app.bracket_inventory')).rows[0].n,6);
 }finally{await db.close();}
});
test('real SQL: insufficient stock, self-transfer and invalid quantity never create stock',async()=>{
 const db=await database();try{
  await seed(db,ids.a,1,0,0);
  await assert.rejects(rpc(db,'inventory_transfer',transfer(ids.a,ids.b,quantities(2))),/insufficient_transfer_stock/);
  await assert.rejects(rpc(db,'inventory_transfer',transfer(ids.a,ids.a)),/distinct_technicians/);
  await assert.rejects(rpc(db,'inventory_transfer',transfer(ids.a,ids.b,quantities(-1))),/invalid_quantity/);
  await assert.rejects(rpc(db,'inventory_transfer',transfer(ids.a,ids.b,quantities())),/positive_transfer/);
  assert.equal((await stock(db,ids.a)).flat_qty,1);assert.equal(await stock(db,ids.b),undefined);
  assert.equal((await db.query("select count(*)::int n from app.inventory_events where event_id like 'transfer:%'")).rows[0].n,0);
 }finally{await db.close();}
});
test('real SQL: destination write failure rolls back source and operation identity',async()=>{
 const db=await database();try{
  await seed(db,ids.a);await seed(db,ids.b,0,0,0);
  await db.exec(`create function app.test_transfer_fail() returns trigger language plpgsql as $$begin if new.technician_id='${ids.b}' and new.flat_delta>0 then raise exception 'injected_destination_failure';end if;return new;end$$;create trigger test_transfer_fail before insert on app.bracket_moves for each row execute function app.test_transfer_fail();`);
  const payload=transfer();await assert.rejects(rpc(db,'inventory_transfer',payload),/injected_destination_failure/);
  assert.equal((await stock(db,ids.a)).flat_qty,5);assert.equal((await stock(db,ids.b)).flat_qty,0);
  assert.equal((await db.query('select count(*)::int n from app.inventory_events where event_id=$1',['transfer:'+payload.event_id])).rows[0].n,0);
  await db.exec('drop trigger test_transfer_fail on app.bracket_moves');await rpc(db,'inventory_transfer',payload);assert.equal((await stock(db,ids.a)).flat_qty,3);
 }finally{await db.close();}
});
test('real SQL: received recipient corrections move proven credits and support A-B-A-B',async()=>{
 const db=await database();try{
  await seed(db,ids.a,0,0,0);await seed(db,ids.b,0,0,0);const purchase=await receivedOrder(db);
  const first=reassign(purchase);await rpc(db,'inventory_reassign',first);assert.equal((await stock(db,ids.a)).flat_qty,0);assert.equal((await stock(db,ids.b)).flat_qty,3);
  assert.equal((await rpc(db,'inventory_reassign',first)).duplicate,true);
  await rpc(db,'inventory_reassign',reassign(purchase,ids.a));await rpc(db,'inventory_reassign',reassign(purchase,ids.b));
  assert.equal((await stock(db,ids.a)).flat_qty,0);assert.equal((await stock(db,ids.b)).flat_qty,3);
  const row=(await db.query('select * from app.bracket_purchases where id=$1',[purchase])).rows[0];assert.equal(row.technician_id,ids.b);assert.equal(row.receipt_evidence.recipient_override,true);
 }finally{await db.close();}
});
test('real SQL: physical-count boundary blocks historical receipt movement, including destination',async()=>{
 const db=await database();try{
  await seed(db,ids.a,0,0,0);await seed(db,ids.b,0,0,0);const purchase=await receivedOrder(db);const target=await stock(db,ids.b);
  await recount(supabaseFor(db),{technicianId:ids.b,flat:0,expectedUpdatedAt:target.version,requestId:randomUUID(),reason:'Counted destination flat stock',actor:'test'});
  const result=await rpc(db,'inventory_reassign',reassign(purchase));assert.equal(result.inventory_status,'review');assert.equal(result.review_reason,'recount_boundary_requires_review');
  assert.equal((await stock(db,ids.a)).flat_qty,3);assert.equal((await stock(db,ids.b)).flat_qty,0);
  assert.equal((await db.query('select technician_id from app.bracket_purchases where id=$1',[purchase])).rows[0].technician_id,ids.a);
 }finally{await db.close();}
});
test('real SQL: unrelated type recount does not block a proven flat-only correction',async()=>{
 const db=await database();try{
  await seed(db,ids.a,0,0,0);await seed(db,ids.b,0,0,0);const purchase=await receivedOrder(db);const target=await stock(db,ids.b);
  await recount(supabaseFor(db),{technicianId:ids.b,tilting:0,expectedUpdatedAt:target.version,requestId:randomUUID(),reason:'Counted only tilting stock',actor:'test'});
  assert.equal((await rpc(db,'inventory_reassign',reassign(purchase))).inventory_status,'recorded');assert.equal((await stock(db,ids.b)).flat_qty,3);
 }finally{await db.close();}
});
test('real SQL: delayed receipt uses physical event time before destination recount',async()=>{
 const db=await database();try{
  await seed(db,ids.a,0,0,0);await seed(db,ids.b,0,0,0);
  const occurred=(await db.query('select clock_timestamp()::text at')).rows[0].at;
  const target=await stock(db,ids.b);
  await recount(supabaseFor(db),{technicianId:ids.b,flat:3,expectedUpdatedAt:target.version,requestId:randomUUID(),reason:'Counted brackets after actual arrival',actor:'test'});
  const receipt=await syncBracketOrder(supabaseFor(db),{orderNum:'test-email-'+randomUUID(),event_id:randomUUID(),source:'walmart_email',source_fingerprint:randomUUID(),facts_verified:true,technician_id:ids.a,business_id:ids.business,status:'delivered',ordered:quantities(3),received:quantities(3),receipt_scope:'cumulative',receipt_verified:true,occurred_at:occurred,actor:'test'});
  assert.equal(receipt.inventory_status,'recorded');
  const purchase=receipt.purchase_id;
  const result=await rpc(db,'inventory_reassign',reassign(purchase));
  assert.equal(result.review_reason,'recount_boundary_requires_review');
  assert.equal((await stock(db,ids.a)).flat_qty,3);assert.equal((await stock(db,ids.b)).flat_qty,3);
 }finally{await db.close();}
});
test('real SQL: legacy and unproven received quantities require review without moving stock',async()=>{
 const db=await database();try{
  await seed(db,ids.a,5,0,0);await seed(db,ids.b,0,0,0);const purchase=await receivedOrder(db);
  await db.query("insert into app.inventory_legacy_entities values('order',$1)",[purchase]);
  assert.equal((await rpc(db,'inventory_reassign',reassign(purchase))).review_reason,'legacy_recipient_requires_review');
  await db.query("delete from app.inventory_legacy_entities where entity_type='order' and entity_id=$1",[purchase]);
  await db.query('update app.bracket_purchases set received_flat_qty=4 where id=$1',[purchase]);
  assert.equal((await rpc(db,'inventory_reassign',reassign(purchase))).review_reason,'receipt_allocation_mismatch');
  assert.equal((await stock(db,ids.a)).flat_qty,8);assert.equal((await stock(db,ids.b)).flat_qty,0);
 }finally{await db.close();}
});
test('real SQL: missing immutable receipt time cannot move stock across unknown history',async()=>{
 const db=await database();try{
  await seed(db,ids.a,0,0,0);await seed(db,ids.b,0,0,0);const purchase=await receivedOrder(db);
  await db.query("update app.inventory_events set result=result-'receipt_occurred_at' where result->>'purchase_id'=$1",[purchase]);
  const result=await rpc(db,'inventory_reassign',reassign(purchase));
  assert.equal(result.review_reason,'recount_boundary_requires_review');
  assert.equal((await stock(db,ids.a)).flat_qty,3);assert.equal((await stock(db,ids.b)).flat_qty,0);
 }finally{await db.close();}
});
test('real SQL: unreceived assignment changes no balances and stale/canceled orders reject',async()=>{
 const db=await database();try{
  const id=randomUUID();await db.query("insert into app.bracket_purchases(id,business_id,walmart_order_num,status,flat_qty) values($1,$2,'pending-test-order','in_route',4)",[id,ids.business]);
  const result=await rpc(db,'inventory_reassign',reassign(id));assert.equal(result.inventory_status,'unreceived');assert.equal(await stock(db,ids.b),undefined);
  await assert.rejects(rpc(db,'inventory_reassign',{...reassign(id,ids.a),expected_updated_at:'2000-01-01T00:00:00Z'}),/version_conflict/);
  await db.query("update app.bracket_purchases set status='canceled' where id=$1",[id]);await assert.rejects(rpc(db,'inventory_reassign',reassign(id,ids.a)),/closed_order/);
 }finally{await db.close();}
});
test('real SQL: transfer entry points are restricted and helper is private',async()=>{
 const db=await database();try{
  const rows=(await db.query("select has_function_privilege('anon','app.inventory_transfer(jsonb)','execute') anon,has_function_privilege('authenticated','app.inventory_reassign(jsonb)','execute') authenticated,has_function_privilege('service_role','app.inventory_transfer(jsonb)','execute') server,has_function_privilege('service_role','app.inventory_move_between(uuid,uuid,jsonb,text,text,text,uuid,text,jsonb)','execute') internal")).rows[0];
  assert.equal(rows.anon,false);assert.equal(rows.authenticated,false);assert.equal(rows.server,true);assert.equal(rows.internal,false);
 }finally{await db.close();}
});
