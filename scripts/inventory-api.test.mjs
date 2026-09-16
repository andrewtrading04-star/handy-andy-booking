import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { inventoryAdmin } from '../api/_lib/inventory-admin.js';
import { writeInventoryJob } from '../api/_lib/inventory-job.js';
import { inventoryError } from '../api/_lib/inventory-job.js';
import { canonicalizeLineItems,recalcTaxLine,isTaxLine,LI_CONFLICT_CODE } from '../api/_lib/line-items.js';
import { createInventoryTestDb,ids } from './lib/inventory-test-db.mjs';
import { apiDb } from './lib/inventory-api-test-db.mjs';

test('inventory API connects to real PostgreSQL without partial or duplicate writes',async t=>{
 const pg=await createInventoryTestDb(),db=apiDb(pg);
 try {
  await pg.exec(`alter table app.businesses add column active boolean default true;alter table app.technicians add column active boolean default true;
    create table app.wire_plate_purchases(id uuid,business_id uuid);`);
  await pg.exec(await fs.readFile(new URL('../supabase/migrations/0113_bracket_shipping_addresses.sql',import.meta.url),'utf8'));
  await pg.exec(await fs.readFile(new URL('../supabase/migrations/0115_inventory_address_controls.sql',import.meta.url),'utf8'));
  const call=async(action,body={},query={},role='owner')=>{
   let code,result;const res={status(n){code=n;return this;},json(v){result=v;return this;}};
   const get=['bracket_inventory','bracket_purchases','bracket_pending','bracket_movements','bracket_exceptions','bracket_shipping_addresses'].includes(action);
   await inventoryAdmin({method:get?'GET':'POST',query},res,db,{role,name:'Test owner'},body,action,{id:ids.business});return {code,result};
  };
  await t.test('reading inventory does not create unknown balances',async()=>{
   const r=await call('bracket_inventory');assert.equal(r.code,200);assert.equal(r.result.inventory.length,3);
   assert.equal(r.result.inventory[0].initialized,false);assert.equal(r.result.inventory[0].updated_at,'uninitialized');
   assert.equal((await pg.query('select count(*)::int n from app.bracket_inventory')).rows[0].n,0);
  });
  await t.test('owner-only physical count rejects blank and preserves unchecked types',async()=>{
   const b={technician_id:ids.a,action:'set',flat:5,expected_updated_at:'uninitialized',operation_id:'count-1',notes:'Physical count'};
   assert.equal((await call('bracket_update',b,{},'secretary')).code,403);
   assert.equal((await call('bracket_update',{...b,flat:''})).code,400);
   let r=await call('bracket_update',b);assert.equal(r.code,200,JSON.stringify(r.result));
   assert.equal((await call('bracket_update',b)).code,200,'retry initial count');
   const inv=r.result.inventory;
   r=await call('bracket_update',{...b,flat:undefined,tilting:7,operation_id:'count-2',expected_updated_at:inv.updated_at});
   assert.equal(r.code,200,JSON.stringify(r.result));assert.equal(r.result.inventory.flat_qty,5);assert.equal(r.result.inventory.tilting_qty,7);
   assert.equal((await call('bracket_update',{...b,operation_id:'stale-count',expected_updated_at:inv.updated_at})).code,409);
   const list=await call('bracket_inventory');assert.equal(list.result.inventory.find(t=>t.technician_id===ids.a).last_verified_at,null);
  });
  let purchase;
  await t.test('manual order retry, partial receipt retry and cancel preserve exact stock',async()=>{
   const b={order_num:'2000999-12345678',technician_id:ids.a,flat_qty:4,tilting_qty:0,full_motion_qty:0,operation_id:'order-1',notes:'Ordered four flat brackets'};
   let r=await call('bracket_record_order',b);assert.equal(r.code,200,JSON.stringify(r.result));purchase=r.result.purchase_id;
   assert.equal((await call('bracket_record_order',b)).code,200,'order retry');
   const receipt={purchase_id:purchase,received_flat:2,received_tilting:0,received_full_motion:0,operation_id:'receipt-1',notes:'Two physically arrived'};
   r=await call('bracket_receive',receipt);assert.equal(r.code,200,JSON.stringify(r.result));assert.equal(r.result.inventory_status,'recorded');
   r=await call('bracket_receive',receipt);assert.equal(r.code,200,JSON.stringify(r.result));
   const cancel={id:purchase,status:'canceled',operation_id:'cancel-1',notes:'Remainder canceled by supplier'};
   r=await call('bracket_set_status',cancel);assert.equal(r.code,200,JSON.stringify(r.result));
   assert.equal((await pg.query('select flat_qty from app.bracket_inventory where technician_id=$1',[ids.a])).rows[0].flat_qty,7);
  });
  await t.test('all open orders survive a short history page',async()=>{
   await pg.exec(`insert into app.bracket_purchases(business_id,technician_id,walmart_order_num,status,inventory_status,flat_qty)
    select '${ids.business}','${ids.a}','history-'||n,'delivered','recorded',1 from generate_series(1,35) n;
    insert into app.bracket_purchases(business_id,technician_id,walmart_order_num,status,inventory_status,flat_qty,created_at)
    values('${ids.business}','${ids.a}','2000999-11111111','in_route','unverified',3,'2020-01-01');`);
   const r=await call('bracket_purchases',{}, {limit:'20'});assert.equal(r.code,200,JSON.stringify(r.result));
   assert.equal(r.result.purchases.length,20);assert.equal(r.result.has_more,true);
   assert(r.result.open_orders.some(p=>p.walmart_order_num==='2000999-11111111'));
  });
  await t.test('job wrapper records physical use before completion and returns atomic editor totals',async()=>{
   await pg.query(`insert into app.bookings(id,business_id,technician_id,scheduled_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')`,[ids.job,ids.business,ids.a]);
   await pg.query(`insert into app.booking_line_items(booking_id,business_id,name,quantity) values($1,$2,'Flat',1)`,[ids.job,ids.business]);
   let booking=(await pg.query('select * from app.bookings where id=$1',[ids.job])).rows[0];
   let r=await writeInventoryJob(db,{booking,businessId:ids.business,body:{id:ids.job,li_rev:0,operation_id:'use'},action:'tech-use',actor:'tech:A',actorTechnicianId:ids.a,confirmUse:true});
   assert.equal(r.inventory_status,'recorded');assert.equal((await pg.query('select status from app.bookings where id=$1',[ids.job])).rows[0].status,'assigned');
   booking=(await pg.query('select * from app.bookings where id=$1',[ids.job])).rows[0];
   r=await writeInventoryJob(db,{booking,businessId:ids.business,body:{id:ids.job,li_rev:r.li_rev,operation_id:'edit'},action:'office-edit',actor:'office',lineItems:[{name:'Flat',quantity:2,kind:'service',unit_price:45,line_total:90,taxable:true}]});
   assert.equal(Number(r.price),90);assert.equal(r.inventory_status,'recorded');
   assert.equal((await pg.query('select flat_qty from app.bracket_inventory where technician_id=$1',[ids.a])).rows[0].flat_qty,5);
  });
  await t.test('shipping mappings require full address and never replace another recipient silently',async()=>{
   let r=await call('bracket_shipping_address_save',{technician_id:ids.a,address:'123 80000',operation_id:'address-1'});assert.equal(r.code,400);
   const b={technician_id:ids.a,address:'123 Example Street, Denver CO 80202',operation_id:'address-2'};
   assert.equal((await call('bracket_shipping_address_save',b)).code,200);
   assert.equal((await call('bracket_shipping_address_save',b)).code,200);
   r=await call('bracket_shipping_address_save',{...b,technician_id:ids.b,operation_id:'address-3'});assert.equal(r.code,409,JSON.stringify(r.result));
  });
  await t.test('actual office and technician editor controllers keep fees, tax, retries and stock consistent',async()=>{
   const admin=await fs.readFile(new URL('../api/admin.js',import.meta.url),'utf8');
   const tech=await fs.readFile(new URL('../api/tech.js',import.meta.url),'utf8');
   const section=(s,a,b)=>{const start=s.indexOf(a),end=s.indexOf(b,start);assert(start>=0&&end>start);return s.slice(start,end);};
   const c=vm.createContext({writeInventoryJob,inventoryError,canonicalizeLineItems,recalcTaxLine,isTaxLine,LI_CONFLICT_CODE,
    resolveBusiness:async()=>({id:ids.business}),bail:(res,e)=>inventoryError(res,e),priceSanityIssue:()=>null,
    scopeMine:(q,auth)=>q.eq('technician_id',auth.tech_id),fetchMine:build=>build(),console});
   vm.runInContext(section(admin,'function sanitizeBookingLineItems(','// Tax constants'),c);
   vm.runInContext(section(admin,'async function bookingLineItemsSave(','// Rewrite a booking\'s stored line items'),c);
   vm.runInContext(section(tech,'function sanitizeWorkLineItems(','// ── Edit a job'),c);
   vm.runInContext(section(tech,'const HIDDEN_LI =','// Count the COMPANY-supplied brackets'),c);
   vm.runInContext(section(tech,'async function jobLineItemsSave(','async function status('),c);
   const invoke=async(fn,body)=>{const res={code:null,result:null,status(n){this.code=n;return this;},json(v){this.result=v;return this;}};
    await c[fn]({method:'POST'},res,db,{role:'owner',name:'Test',tech_id:ids.a},body);return res;};
   const rev=Number((await pg.query('select metadata from app.bookings where id=$1',[ids.job])).rows[0].metadata.li_rev);
   const body={id:ids.job,li_rev:rev,operation_id:'office-editor',items:[
    {name:'Flat',quantity:3,unit_price:45,kind:'service'},
    {name:'Travel',quantity:1,unit_price:20,kind:'fee'},
    {name:'Tax (8.25%)',quantity:1,unit_price:0,kind:'fee',taxable:false}]};
   let r=await invoke('bookingLineItemsSave',body);assert.equal(r.code,200,JSON.stringify(r.result));assert.equal(Number(r.result.price),167.79);
   let retry=await invoke('bookingLineItemsSave',body);assert.equal(retry.code,200,JSON.stringify(retry.result));assert.equal(retry.result.duplicate,true);
   r=await invoke('jobLineItemsSave',{id:ids.job,li_rev:r.result.li_rev,operation_id:'tech-editor',items:[{name:'Flat',quantity:1,unit_price:45}]});
   assert.equal(r.code,200,JSON.stringify(r.result));assert.equal(Number(r.result.price),70.36);
   const rows=(await pg.query('select name from app.booking_line_items where booking_id=$1',[ids.job])).rows;
   assert(rows.some(r=>r.name==='Travel'));assert(rows.some(r=>r.name==='Tax (8.25%)'));
   assert.equal((await pg.query('select flat_qty from app.bracket_inventory where technician_id=$1',[ids.a])).rows[0].flat_qty,6);
   const stale=await invoke('bookingLineItemsSave',{...body,operation_id:'stale-new-operation'});assert.equal(stale.code,409);
  });
 } finally { await pg.close(); }
});
