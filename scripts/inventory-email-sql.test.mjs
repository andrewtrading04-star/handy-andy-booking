import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createInventoryTestDb,ids} from './lib/inventory-test-db.mjs';
import {apiDb} from './lib/inventory-api-test-db.mjs';
import {parseWalmartEmails} from './lib/walmart-parse.mjs';
import {ingestWalmartOrder} from '../api/_lib/bracket-order-ingest.js';
import {saveBracketShippingAddress,normalizeBracketShippingAddress} from '../api/_lib/bracket-shipping.js';

test('supplier intake and managed addresses use real atomic PostgreSQL operations',async t=>{
  const pg=await createInventoryTestDb(),db=apiDb(pg);
  try {
    await pg.exec('alter table app.businesses add column active boolean default true;alter table app.technicians add column active boolean default true;');
    for(const file of ['0113_bracket_shipping_addresses.sql','0115_inventory_address_controls.sql'])await pg.exec(await fs.readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    const address='123 Sample Street, Apt 2, Denver, CO 80231';let mapping;
    await t.test('address create retry is exact; token reuse and implicit takeover fail',async()=>{
      const payload={technicianId:ids.a,address,requestId:'address-create',actor:'Test owner'};
      mapping=(await saveBracketShippingAddress(db,payload)).address;
      const replay=await saveBracketShippingAddress(db,payload);assert.equal(replay.duplicate,true);assert.equal(replay.address.id,mapping.id);
      await assert.rejects(saveBracketShippingAddress(db,{...payload,technicianId:ids.b}),/idempotency_conflict/);
      await assert.rejects(saveBracketShippingAddress(db,{...payload,requestId:'address-takeover',technicianId:ids.b}),/already_assigned/);
      assert.equal((await pg.query('select count(*)::int n from app.bracket_shipping_addresses')).rows[0].n,1);
    });
    await t.test('address edits require current version; explicit mapping correction is retry-safe',async()=>{
      await assert.rejects(saveBracketShippingAddress(db,{id:mapping.id,technicianId:ids.b,address,requestId:'edit-no-version'}),/version/);
      const payload={id:mapping.id,technicianId:ids.a,address,active:false,requestId:'deactivate',expectedUpdatedAt:mapping.updated_at};
      const saved=await saveBracketShippingAddress(db,payload);assert.equal(saved.address.active,false);
      assert.equal((await saveBracketShippingAddress(db,payload)).duplicate,true);
      await assert.rejects(saveBracketShippingAddress(db,{...payload,active:true,requestId:'stale-edit'}),/version_conflict/);
      mapping=(await saveBracketShippingAddress(db,{...payload,active:true,requestId:'reactivate',expectedUpdatedAt:saved.address.updated_at})).address;
    });
    await t.test('SQL and server full-address normalization agree including units and ZIP+4',async()=>{
      for(const raw of [address,'123 Sample St., Apt 2, Denver, CO 80231-1234, USA','123 SAMPLE ST, APT 3, Denver, CO 80231']){
        const sql=(await pg.query('select app.inventory_normalize_shipping_address($1) as address',[raw])).rows[0].address;
        assert.equal(sql,normalizeBracketShippingAddress(raw));
      }
    });
    const number='2000991-12345678',time=new Date(Date.now()+1000).toISOString();
    const base={from:'help@walmart.com',authenticationResults:'mx.google.com; dkim=pass header.i=@walmart.com;',emailDateISO:time};
    const parse=patch=>parseWalmartEmails({...base,...patch})[0];
    const order=parse({messageId:'<new-order>',subject:'Thanks for your delivery order',text:`Order number: ${number}\nquantity 3 item onn Fixed TV Wall Mount\n${address}`});
    await t.test('confirmation assigns exact verified address without adding stock',async()=>{
      const r=await ingestWalmartOrder(db,order);assert.equal(r.status,'synced');
      const p=(await pg.query('select * from app.bracket_purchases where walmart_order_num=$1',[number])).rows[0];
      assert.equal(p.technician_id,ids.a);assert.equal(p.flat_qty,3);
      assert.equal((await pg.query('select count(*)::int n from app.bracket_moves where order_num=$1',[number])).rows[0].n,0);
    });
    await t.test('complete status-only receipt credits stored authoritative quantity exactly once',async()=>{
      const event=parse({messageId:'<new-delivery>',subject:'Your order has been delivered',text:`Order number: ${number}`,emailDateISO:new Date(Date.parse(time)+1000).toISOString()});
      assert.equal(event.received,null);assert.equal(event.receipt_verified,true);
      const r=await ingestWalmartOrder(db,event);assert.equal(r.inventory_status,'recorded',JSON.stringify(r));
      assert.equal((await ingestWalmartOrder(db,event)).duplicate,true);
      const stock=(await pg.query('select flat_qty from app.bracket_inventory where technician_id=$1',[ids.a])).rows[0];assert.equal(stock.flat_qty,3);
    });
    await t.test('title-only partial package cannot decrease or increase received stock',async()=>{
      const event=parse({messageId:'<partial-title-only>',subject:'Your package arrived',text:`Order number: ${number}\nonn Fixed TV Wall Mount`,emailDateISO:new Date(Date.parse(time)+2000).toISOString()});
      const r=await ingestWalmartOrder(db,event);assert.equal(r.status,'review');
      assert.equal((await pg.query('select flat_qty from app.bracket_inventory where technician_id=$1',[ids.a])).rows[0].flat_qty,3);
    });
    await t.test('unverified cancellation cannot poison authoritative status or chronology',async()=>{
      const event=parse({messageId:'<spoof-cancel>',subject:'Your order was canceled',text:`Order number: ${number}`,authenticationResults:'',emailDateISO:'2099-01-01T00:00:00Z'});
      const before=(await pg.query('select status,last_event_at from app.bracket_purchases where walmart_order_num=$1',[number])).rows[0];
      assert.equal((await ingestWalmartOrder(db,event)).status,'review');
      assert.deepEqual((await pg.query('select status,last_event_at from app.bracket_purchases where walmart_order_num=$1',[number])).rows[0],before);
    });
    await t.test('same source replay survives a later technician assignment without idempotency conflict',async()=>{
      const other='2000992-12345678',event=parse({messageId:'<unassigned-order>',subject:'Thanks for your delivery order',text:`Order number: ${other}\nquantity 2 item onn Tilting TV Wall Mount`});
      const original=await ingestWalmartOrder(db,event);assert.equal(original.status,'review');
      await pg.query('update app.bracket_purchases set technician_id=$1 where id=$2',[ids.b,original.purchase_id]);
      const replay=await ingestWalmartOrder(db,event);assert.equal(replay.duplicate,true);assert.equal(replay.status,'review');assert.equal(replay.review_pending,true);
    });
  }finally {await pg.close();}
});
