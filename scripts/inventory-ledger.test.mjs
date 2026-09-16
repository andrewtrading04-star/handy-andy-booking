import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInventoryTestDb, applyInventoryMigration, supabaseFor, ids } from './lib/inventory-test-db.mjs';
import { classifyBracketMaterials, requireBracketQuantities } from '../api/_lib/bracket-materials.js';
import { saveJobInventory, recount, syncBracketOrder } from '../api/_lib/bracket-moves.js';

const q = (flat=0,tilting=0,full_motion=0) => ({flat,tilting,full_motion});
const line = (name='Flat',quantity=1) => ({name,quantity,kind:'option',unit_price:25,line_total:quantity*25,taxable:true});
async function stock(db,tech=ids.a) {return (await db.query('select *,updated_at::text as version from app.bracket_inventory where technician_id=$1',[tech])).rows[0];}
async function seed(db,tech=ids.a,flat=5,tilting=5,fm=5) {await db.query(`select app.bracket_move(null,$1,'adjust',$2,$3,$4,$5,null,null,null,'test opening count','test')`,[tech,flat,tilting,fm,randomUUID()]);}
async function job(db,{lines=[line()],supplier=null,secondary=null,status='assigned'}={}) {
 const id=randomUUID();await db.query('insert into app.bookings(id,business_id,technician_id,secondary_technician_id,bracket_supplied_by,status,scheduled_at) values($1,$2,$3,$4,$5,$6,clock_timestamp())',[id,ids.business,ids.a,secondary,supplier,status]);
 for(const l of lines) await db.query('insert into app.booking_line_items(booking_id,business_id,name,quantity,unit_price,line_total,kind) values($1,$2,$3,$4,$5,$6,$7)',[id,ids.business,l.name,l.quantity,l.unit_price,l.line_total,l.kind]);
 return {id,lines};
}
async function write(db,j,{rev=0,lines=null,patch={status:'completed',completed_at:new Date().toISOString()},requestId=randomUUID(),confirmUse=false}={}) {
 return saveJobInventory(supabaseFor(db),{bookingId:j.id,businessId:ids.business,expectedLiRev:rev,lineItems:lines,patch,materials:classifyBracketMaterials(lines||j.lines),requestId,actor:'test',confirmUse});
}

test('classifier recognizes exact catalog / structured material and refuses ambiguous duplicates',()=>{
 for(const name of ["Customer's own full motion bracket",'Flat rate installation','Fixed the drywall','I have my own tilting bracket','Samsung Frame in-box bracket']) assert.deepEqual(classifyBracketMaterials([line(name)]).qtys,q());
 assert.deepEqual(classifyBracketMaterials([line('Full Motion ×3')]).qtys,q(0,0,3));
 assert.deepEqual(classifyBracketMaterials([line('85"-100" TV Tilting Bracket',2)]).qtys,q(0,2,0));
 assert.deepEqual(classifyBracketMaterials([line('Flat (85" and up)'),line('Tilting (85" and up)'),line('Full Motion (85" and up)')]).qtys,q(1,1,1));
 assert.equal(classifyBracketMaterials([line('Full Motion ×3',2)]).issues[0].code,'quantity_conflict');
 assert.equal(classifyBracketMaterials([line('Tilting (recommended)',3),line('Tilting Mounts',3)]).issues[0].code,'possible_duplicate_material');
 assert.deepEqual(classifyBracketMaterials([{...line('Any invoice wording',2),material_type:'flat',material_owner:'company'}]).qtys,q(2));
 for(const bad of ['',null,true,' ']) assert.throws(()=>requireBracketQuantities({flat:bad}),/Invalid flat quantity/);
});

test('real SQL: completion, retry, stale revision and completed edits are atomic',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);const j=await job(db), requestId=randomUUID();
  const first=await write(db,j,{requestId});assert.equal(first.inventory_status,'recorded');assert.equal((await stock(db)).flat_qty,4);
  const replay=await write(db,j,{requestId,rev:1});assert.equal(replay.duplicate,true);assert.equal((await stock(db)).flat_qty,4);
  await assert.rejects(write(db,j,{rev:0}),/version_conflict/);
  const edited=await write(db,j,{rev:1,lines:[line('Tilting',2),{...line('Tax (8.25%)'),unit_price:4.13,line_total:4.13}],patch:{extra_slots:['s3']}});
  assert.equal(edited.price,54.13);assert.equal(edited.subtotal,50);
  const saved=(await db.query('select metadata,extra_slots from app.bookings where id=$1',[j.id])).rows[0];
  assert.deepEqual(saved.extra_slots,['s3']);assert.equal(saved.metadata.li_backups[0].items[0].name,'Flat');
  const s=await stock(db);assert.equal(s.flat_qty,5);assert.equal(s.tilting_qty,3);
 }finally{await db.close();}
});

test('real SQL: first company bracket after zero-bracket completion and use before payment',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);const j=await job(db,{lines:[line('Customer supplied bracket')]});await write(db,j);
  await write(db,j,{rev:1,lines:[line('Flat')],patch:{}});assert.equal((await stock(db)).flat_qty,4);
  const active=await job(db);await write(db,active,{patch:{},confirmUse:true});assert.equal((await stock(db)).flat_qty,3);
  assert.equal((await db.query('select status from app.bookings where id=$1',[active.id])).rows[0].status,'assigned');
 }finally{await db.close();}
});

test('real SQL: fallback supplier and A→B→A→B cycles conserve inventory',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);await seed(db,ids.b);const j=await job(db);await write(db,j);
  await write(db,j,{rev:1,patch:{secondary_technician_id:ids.b,bracket_supplied_by:ids.b}});
  assert.equal((await stock(db)).flat_qty,5);assert.equal((await stock(db,ids.b)).flat_qty,4);
  await write(db,j,{rev:2,patch:{bracket_supplied_by:ids.a}});
  await write(db,j,{rev:3,patch:{bracket_supplied_by:ids.b}});
  assert.equal((await stock(db)).flat_qty,5);assert.equal((await stock(db,ids.b)).flat_qty,4);
 }finally{await db.close();}
});

test('real SQL: clamped use corrections never invent stock',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db,ids.a,0,0,0);await seed(db,ids.b);const j=await job(db);const first=await write(db,j);assert.equal(first.inventory_status,'shortfall');
  await write(db,j,{rev:1,patch:{secondary_technician_id:ids.b,bracket_supplied_by:ids.b}});
  assert.equal((await stock(db)).flat_qty,0);assert.equal((await stock(db,ids.b)).flat_qty,4);
  const second=await job(db);await write(db,second);await write(db,second,{rev:1,lines:[line('Customer supplied bracket')],patch:{}});
  assert.equal((await stock(db)).flat_qty,0);
 }finally{await db.close();}
});

test('real SQL: failed line replacement rolls back the stock and job revision',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);const j=await job(db);await write(db,j);
  await db.exec(`create function app.test_fail_line() returns trigger language plpgsql as $$begin if new.name='Tilting' then raise exception 'injected_insert_failure';end if;return new;end$$;
  create trigger fail_line before insert on app.booking_line_items for each row execute function app.test_fail_line();`);
  await assert.rejects(write(db,j,{rev:1,lines:[line('Tilting')],patch:{}}),/injected_insert_failure/);
  const s=await stock(db);assert.equal(s.flat_qty,4);assert.equal(s.tilting_qty,5);
  assert.equal((await db.query('select metadata from app.bookings where id=$1',[j.id])).rows[0].metadata.li_rev,1);
  assert.equal((await db.query('select name from app.booking_line_items where booking_id=$1',[j.id])).rows[0].name,'Flat');
 }finally{await db.close();}
});

test('real SQL: material snapshot mismatch and ambiguous material never guess',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);const j=await job(db);j.lines=[line('Tilting')];await assert.rejects(write(db,j),/snapshot_conflict/);
  const dup=await job(db,{lines:[line('Tilting'),line('Tilting Mounts')]});const r=await write(db,dup);
  assert.equal(r.inventory_status,'review');assert.equal((await stock(db)).tilting_qty,5);
  assert.equal((await db.query("select count(*)::int n from app.inventory_exceptions where entity_id=$1 and status='open'",[dup.id])).rows[0].n,1);
 }finally{await db.close();}
});

test('real SQL: historical jobs cannot replay after migration or physical count',async()=>{
 const db=await createInventoryTestDb({migrations:false});try {
  const legacy=await job(db,{status:'completed'});await applyInventoryMigration(db);await seed(db);
  assert.equal((await write(db,legacy)).review_reason,'legacy_job_requires_review');assert.equal((await stock(db)).flat_qty,5);
  const j=await job(db);await write(db,j);const before=await stock(db);
  await recount(supabaseFor(db),{technicianId:ids.a,flat:4,expectedUpdatedAt:before.version,reason:'Physical count',requestId:randomUUID()});
  const correction=await write(db,j,{rev:1,lines:[line('Customer supplied bracket')],patch:{}});
  assert.equal(correction.review_reason,'recount_boundary_requires_review');assert.equal((await stock(db)).flat_qty,4);
 }finally{await db.close();}
});

test('real SQL: recount is partial, versioned, stable on retry and can initialize safely',async()=>{
 const db=await createInventoryTestDb();try {
  const initial=await recount(supabaseFor(db),{technicianId:ids.a,flat:5,tilting:3,fullMotion:2,expectedUpdatedAt:'uninitialized',reason:'Count',requestId:randomUUID()});
  const before=await stock(db), args={technicianId:ids.a,flat:4,expectedUpdatedAt:before.version,reason:'Count flats only',requestId:randomUUID()};
  await recount(supabaseFor(db),args);assert.equal((await recount(supabaseFor(db),args)).duplicate,true);
  const after=await stock(db);assert.equal(after.flat_qty,4);assert.equal(after.tilting_qty,3);assert.equal(after.full_motion_qty,2);
  await assert.rejects(recount(supabaseFor(db),{...args,requestId:randomUUID()}),/version_conflict/);
  await assert.rejects(recount(supabaseFor(db),{...args,expectedUpdatedAt:'uninitialized',requestId:randomUUID()}),/version_conflict/);
 }finally{await db.close();}
});

test('real SQL: receipts require evidence and apply only cumulative differences',async()=>{
 const db=await createInventoryTestDb();try {
  const client=supabaseFor(db), orderNum='test-'+randomUUID();
  const base={orderNum,business_id:ids.business,technician_id:ids.a,occurred_at:new Date().toISOString(),source:'test',facts_verified:true,actor:'test'};
  await syncBracketOrder(client,{...base,event_id:randomUUID(),ordered:q(4),status:'in_route'});
  const missing=await syncBracketOrder(client,{...base,event_id:randomUUID(),status:'delivered'});assert.equal(missing.status,'review');assert.equal(await stock(db),undefined);
  const first={...base,event_id:randomUUID(),status:'delivered',receipt_scope:'cumulative',receipt_verified:true,received:q(2)};
  const firstResult=await syncBracketOrder(client,first);
  assert.equal(firstResult.status,'synced');assert.equal(Date.parse(firstResult.receipt_occurred_at),Date.parse(base.occurred_at));assert.equal((await stock(db)).flat_qty,2);
  const storedReceipt=(await db.query('select result from app.inventory_events where event_id=$1',['order:'+first.event_id])).rows[0].result;
  assert.equal(Date.parse(storedReceipt.receipt_occurred_at),Date.parse(base.occurred_at));
  assert.equal((await syncBracketOrder(client,first)).duplicate,true);assert.equal((await stock(db)).flat_qty,2);
  await syncBracketOrder(client,{...first,event_id:randomUUID(),received:q(4)});assert.equal((await stock(db)).flat_qty,4);
  const canceled=await syncBracketOrder(client,{...base,event_id:randomUUID(),status:'canceled'});assert.equal(canceled.status,'review');assert.equal((await stock(db)).flat_qty,4);
 }finally{await db.close();}
});

test('real SQL: PUBLIC privileges revoked, direct counter writes and ledger edits blocked',async()=>{
 const db=await createInventoryTestDb();try {
  await seed(db);
  const perms=await db.query("select has_function_privilege('anon','app.bracket_move(uuid,uuid,text,integer,integer,integer,text,uuid,uuid,text,text,text)','execute') allowed");assert.equal(perms.rows[0].allowed,false);
  await assert.rejects(db.exec('update app.bracket_inventory set flat_qty=999'),/direct_write_forbidden/);
  await assert.rejects(db.exec("update app.bracket_moves set reason='rewrite'"),/append_only/);
  await db.exec('set role service_role');
  await assert.rejects(db.exec('update app.bracket_inventory set flat_qty=999'),/direct_write_forbidden/);
  await assert.rejects(db.exec('update app.bracket_inventory set flat_verified_at=clock_timestamp()'),/direct_write_forbidden/);
  await assert.rejects(db.exec("insert into app.inventory_events values('forged','{}','{}',clock_timestamp())"),/permission denied/);
  await db.query("select app.bracket_move(null,$1,'adjust',1,0,0,$2,null,null,null,'authorized server operation','test')",[ids.a,randomUUID()]);
  await db.exec('reset role');assert.equal((await stock(db)).flat_qty,6);
 }finally{await db.close();}
});

test('real SQL: independent first-row events survive and conflicting replay is rejected',async()=>{
 const db=await createInventoryTestDb();try {
  const call=(key,n)=>db.query("select app.bracket_move(null,$1,'adjust',$2,0,0,$3,null,null,null,'test','test')",[ids.a,n,key]);
  const first=randomUUID(),second=randomUUID();await Promise.all([call(first,2),call(second,3)]);
  assert.equal((await stock(db)).flat_qty,5);await call(first,2);assert.equal((await stock(db)).flat_qty,5);
  await assert.rejects(call(first,8),/idempotency_conflict/);assert.equal((await stock(db)).flat_qty,5);
 }finally{await db.close();}
});

test('real SQL: late historical, regressing and legacy receipts stay in review',async()=>{
 const db=await createInventoryTestDb({migrations:false});try {
  await db.query("insert into app.bracket_purchases(business_id,technician_id,walmart_order_num,flat_qty,status) values($1,$2,'legacy',4,'delivered')",[ids.business,ids.a]);
  await applyInventoryMigration(db);const client=supabaseFor(db);
  const p={business_id:ids.business,technician_id:ids.a,event_id:randomUUID(),status:'delivered',ordered:q(4),received:q(4),receipt_scope:'complete',receipt_verified:true,facts_verified:true,occurred_at:new Date().toISOString()};
  assert.equal((await syncBracketOrder(client,{...p,orderNum:'legacy'})).review_reason,'legacy_receipt_requires_review');
  const old={...p,orderNum:'old-'+randomUUID(),event_id:randomUUID(),occurred_at:'2020-01-01T00:00:00Z'};
  assert.equal((await syncBracketOrder(client,old)).review_reason,'historical_receipt_requires_review');
  const fresh={...p,orderNum:'new-'+randomUUID(),event_id:randomUUID()};await syncBracketOrder(client,fresh);assert.equal((await stock(db)).flat_qty,4);
  const reduced={...fresh,event_id:randomUUID(),received:q(2)};
  assert.equal((await syncBracketOrder(client,reduced)).review_reason,'received_quantity_regression');assert.equal((await stock(db)).flat_qty,4);
  assert.equal((await syncBracketOrder(client,reduced)).status,'review');
  await applyInventoryMigration(db);assert.equal((await db.query("select count(*)::int n from app.inventory_legacy_entities where entity_type='order' and entity_id=(select id from app.bracket_purchases where walmart_order_num=$1)",[fresh.orderNum])).rows[0].n,0);
 }finally{await db.close();}
});

test('real SQL: untrusted review cannot cancel or poison order chronology; late confirmed totals are retained',async()=>{
 const db=await createInventoryTestDb();try {
  const client=supabaseFor(db),orderNum='timing-'+randomUUID(),time=new Date().toISOString();
  const base={orderNum,business_id:ids.business,technician_id:ids.a,source:'walmart_email',facts_verified:true,occurred_at:time};
  await syncBracketOrder(client,{...base,event_id:randomUUID(),status:'in_route'});
  const untrusted={...base,event_id:randomUUID(),source:'legacy_status_override',facts_verified:false,ordered:q(99),status:'canceled',occurred_at:'2099-01-01T00:00:00Z',review_reason:'untrusted_sender'};
  await syncBracketOrder(client,untrusted);
  let p=(await db.query('select *,last_event_at::text event_time from app.bracket_purchases where walmart_order_num=$1',[orderNum])).rows[0];
  assert.equal(p.status,'in_route');assert.equal(p.flat_qty,0);assert.ok(!p.event_time.startsWith('2099'));
  await syncBracketOrder(client,{...base,event_id:randomUUID(),ordered:q(4),status:'ordered',occurred_at:new Date(Date.parse(time)-1000).toISOString()});
  p=(await db.query('select * from app.bracket_purchases where walmart_order_num=$1',[orderNum])).rows[0];assert.equal(p.flat_qty,4);assert.equal(p.status,'in_route');
  await syncBracketOrder(client,{...base,event_id:randomUUID(),status:'delivered',receipt_scope:'complete',receipt_verified:true});assert.equal((await stock(db)).flat_qty,4);
 }finally{await db.close();}
});

test('real SQL: source fingerprint survives assignment lookup changes, manual request retries and version checks',async()=>{
 const db=await createInventoryTestDb();try {
  const client=supabaseFor(db),orderNum='retry-'+randomUUID();
  const original={orderNum,business_id:ids.business,event_id:randomUUID(),source:'walmart_email',source_fingerprint:'immutable-message-hash',facts_verified:true,occurred_at:new Date().toISOString(),ordered:q(4),status:'ordered',review_reason:'shipping_address_unassigned'};
  const first=await syncBracketOrder(client,original);assert.equal(first.status,'review');
  const replay=await syncBracketOrder(client,{...original,technician_id:ids.a,review_reason:null});assert.equal(replay.duplicate,true);assert.equal(replay.status,'review');assert.equal(replay.review_pending,true);
  const manual={orderNum:'manual-'+randomUUID(),business_id:ids.business,technician_id:ids.a,event_id:randomUUID(),source:'manual',ordered:q(4),status:'in_route',expected_absent:true,occurred_at:new Date().toISOString()};
  await syncBracketOrder(client,manual);assert.equal((await syncBracketOrder(client,{...manual,occurred_at:new Date(Date.now()+1000).toISOString()})).duplicate,true);
  await assert.rejects(syncBracketOrder(client,{...manual,event_id:randomUUID()}),/version_conflict/);
  await assert.rejects(syncBracketOrder(client,{...manual,event_id:randomUUID(),expected_absent:false,expected_updated_at:'2000-01-01T00:00:00Z'}),/version_conflict/);
 }finally{await db.close();}
});
