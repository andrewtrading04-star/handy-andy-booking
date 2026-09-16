import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseWalmartEmails,extractBracketEvidence,detectStatus,extractArrivesDate,walmartProvenance} from './lib/walmart-parse.mjs';
import {orderedWalmartEvents,walmartScanSince,gmailAuthenticationResults,searchMailboxUids} from './lib/walmart-sync.mjs';
import {scanInventoryMailbox} from './lib/inventory-mailbox.mjs';
import {ingestWalmartOrder} from '../api/_lib/bracket-order-ingest.js';
import {normalizeBracketShippingAddress,validBracketShippingAddress,matchBracketShippingAddress} from '../api/_lib/bracket-shipping.js';

const number='1234567-12345678';
const confirmation={subject:'Thanks for your delivery order',text:`Order number: ${number}\nquantity 3 item onn Fixed TV Wall Mount\nOrder total $90.00`,from:'help@walmart.com',authenticationResults:'mx.google.com; dkim=pass header.i=@walmart.com;',messageId:'<confirmation@example>',emailDateISO:'2026-09-16T09:00:00Z'};
const parse=(patch={})=>parseWalmartEmails({...confirmation,...patch})[0];

test('explicit three bracket types preserve quantities without duplicate HTML',()=>{
  const text=`Order number: ${number}\nquantity 3 item onn Fixed TV Wall Mount\nquantity 2 item onn Tilting TV Wall Mount\nquantity 4 item onn Full Motion TV Wall Mount with Tilting`;
  const event=parse({text,html:text});
  assert.deepEqual(event.ordered,{flat:3,tilting:2,full_motion:4});assert.equal(event.review_reason,null);
});
test('plaintext without items uses explicit HTML alt quantities',()=>{
  const event=parse({text:`Order number: ${number}`,html:`Order number: ${number}<img alt="quantity 3 item onn Fixed TV Wall Mount">`});
  assert.equal(event.ordered.flat,3);
});
test('disagreeing text and HTML quantities require review and cannot credit',()=>{
  const event=parse({html:`Order number: ${number}<img alt="quantity 5 item onn Fixed TV Wall Mount">`});
  assert.equal(event.ordered,null);assert.equal(event.receipt_verified,false);assert.match(event.review_reason,/body_quantity_conflict/);
});
test('title-only does not invent a quantity of one',()=>{
  const event=parse({text:`Order number: ${number}\nonn Fixed TV Wall Mount`});
  assert.equal(event.ordered,null);assert.equal(event.quantities_confidence,'unknown');assert.match(event.review_reason,/quantity_missing/);
});
test('mixed item syntax counts both explicit quantities',()=>{
  const q=extractBracketEvidence('quantity 2 item onn Fixed TV Wall Mount\nonn Tilting TV Wall Mount Qty: 3');
  assert.equal(q.confidence,'explicit');assert.deepEqual(q.quantities,{flat:2,tilting:3,full_motion:0});
});
test('unidentified product brand is never an authoritative stock quantity',()=>{
  const event=parse({text:`Order number: ${number}\nquantity 3 item Unknown Brand Fixed TV Wall Mount`});
  assert.equal(event.ordered,null);assert.match(event.review_reason,/unrecognized_item/);
});
test('cancel link and negated delivery do not become fulfillment events',()=>{
  assert.equal(detectStatus('Thanks for your delivery order',confirmation.text+'\nYou can cancel your order'),'in_route');
  assert.equal(detectStatus('Your order has not been delivered',confirmation.text),'in_route');
  assert.equal(detectStatus('Your order was canceled',confirmation.text),'canceled');
});
test('package delivery stays review; complete order delivery can use persisted quantities',()=>{
  const partial=parse({subject:'Your package arrived',text:`Order number: ${number}\nonn Fixed TV Wall Mount`});
  assert.equal(partial.status,'delivered');assert.equal(partial.receipt_verified,false);assert.equal(partial.received,null);
  const full=parse({subject:'Your order has been delivered',text:`Order number: ${number}`});
  assert.equal(full.receipt_scope,'complete');assert.equal(full.receipt_verified,true);assert.equal(full.received,null);
});
test('explicit partial marker blocks whole-order receipt even with delivered subject',()=>{
  const event=parse({subject:'Your order has been delivered',text:confirmation.text+'\nRemaining items are in another package'});
  assert.equal(event.receipt_scope,'unknown');assert.equal(event.received,null);assert.equal(event.receipt_verified,false);
});
test('shipment quantities never replace confirmed order quantities',()=>{
  const event=parse({subject:'Your package shipped'});assert.equal(event.ordered,null);assert.equal(event.event_kind,'shipment');
});
test('a new scanner date does not alter receipt date or durable source id',()=>{
  const one=parse({subject:'Your order has been delivered',todayISO:'2026-09-16'}),two=parse({subject:'Your order has been delivered',todayISO:'2026-10-01'});
  assert.equal(one.delivered_date,'2026-09-16');assert.equal(one.event_id,two.event_id);
});
test('unrelated customer content cannot be parsed as Walmart',()=>{
  assert.deepEqual(parseWalmartEmails({...confirmation,from:'customer@example.com',authenticationResults:'',subject:'Customer inquiry',text:`Order number: ${number}\nquantity 3 item Fixed TV Wall Mount\ndelivered`}),[]);
});
test('unauthenticated Walmart sender is retained only for review',()=>{
  const event=parse({authenticationResults:''});assert.equal(event.ordered,null);assert.equal(event.receipt_verified,false);assert.match(event.review_reason,/supplier_unverified/);
});
test('authenticated configured forwarder needs original Walmart header and URL',()=>{
  const forward={...confirmation,from:'andrewtrading04@gmail.com',authenticationResults:'mx.google.com; dkim=pass header.i=@gmail.com;',trustedForwarders:['andrewtrading04@gmail.com'],text:'From: Walmart <help@walmart.com>\nDate: Mon, 14 Sep 2026 09:00:00 +0000\n'+confirmation.text+'\nhttps://www.walmart.com/orders/'+number};
  const event=parseWalmartEmails(forward)[0];assert.equal(event.provenance.trusted,true);assert.equal(event.occurred_at,'2026-09-14T09:00:00.000Z');
  assert.equal(walmartProvenance({...forward,trustedForwarders:[]}).trusted,false);
});
test('forwarded receipt with no original date cannot pretend it happened today',()=>{
  const event=parse({subject:'Fwd: Your order has been delivered',from:'andrewtrading04@gmail.com',authenticationResults:'mx.google.com; dkim=pass header.i=@gmail.com;',trustedForwarders:['andrewtrading04@gmail.com'],text:'From: Walmart <help@walmart.com>\n'+confirmation.text+'\nhttps://www.walmart.com/orders/'+number});
  assert.equal(event.occurred_at,null);assert.match(event.review_reason,/source_date_missing/);
});
test('multi-order conversations cannot leak receipt/address decisions between orders',()=>{
  const all=parseWalmartEmails({...confirmation,text:confirmation.text+'\nOrder number: 7654321-87654321\nquantity 4 item onn Tilting TV Wall Mount'});
  assert.equal(all.length,2);for(const event of all){assert.equal(event.ordered,null);assert.equal(event.receipt_verified,false);assert.match(event.review_reason,/multiple_orders/);}
});
test('invalid ETA days are rejected and year rollover follows source date',()=>{
  assert.equal(extractArrivesDate('Arrives Feb 31','2026-02-01'),null);
  assert.equal(extractArrivesDate('Arrives Jan 2','2026-12-30'),'2027-01-02');
});
test('email events are ordered and deduplicated without merging quantities or statuses',()=>{
  const order=parse(),delivery=parse({messageId:'<delivered@example>',subject:'Your package arrived',emailDateISO:'2026-09-17T09:00:00Z',text:`Order number: ${number}\nquantity 1 item onn Fixed TV Wall Mount`});
  const events=orderedWalmartEvents([delivery,order,order]);assert.equal(events.length,2);assert.equal(events[0].ordered.flat,3);assert.equal(events[1].received,null);
  const later=orderedWalmartEvents([delivery]);assert.equal(later[0].ordered,null);assert.equal(later[0].received,null);
});
test('persisted checkpoint expands recovery beyond rolling window after long outage',()=>{
  assert.equal(walmartScanSince('2026-01-01T00:00:00Z',45,new Date('2026-09-16')).toISOString(),'2025-12-30T00:00:00.000Z');
});
test('both Walmart searches failing cannot be hidden by unrelated search results',async()=>{
  await assert.rejects(searchMailboxUids({search:async()=>{throw Error('fail');}},new Date(),[{from:'walmart.com'},{body:'walmart'}]),e=>e.code==='SEARCH_FAILED');
});
test('Gmail authentication reads receiver header only',()=>{
  assert.equal(gmailAuthenticationResults({headerLines:[{key:'authentication-results',line:'Authentication-Results: forged.example; dkim=pass header.i=@walmart.com;'}]}),'');
});

function mailbox(options={}) {
  const calls=[];
  class ImapFlow {
    on(){}async connect(){}async logout(){}close(){}
    async list(){return options.noArchive?[]:[{path:'[Gmail]/All Mail',specialUse:'\\All'}];}
    async mailboxOpen(path){this.path=path;calls.push(path);}
    async search(term){if(options.searchFail&&this.path==='[Gmail]/All Mail')throw Error('fail');return this.path==='[Gmail]/All Mail'||options.noArchive?[1]:[];}
    async *fetch(){yield {uid:1,source:{...confirmation,date:new Date(confirmation.emailDateISO),from:{value:[{address:'help@walmart.com'}]},headerLines:[{key:'authentication-results',line:'Authentication-Results: mx.google.com; dkim=pass header.i=@walmart.com;'}]}};}
  }
  return {calls,run:()=>scanInventoryMailbox({box:{user:'andrewtrading04@gmail.com',pass:'mock',idx:1},todayISO:'2026-09-16',now:new Date('2026-09-16T10:00:00Z'),ImapFlow,simpleParser:async source=>{if(options.parseFail)throw Error('fail');return source;}})};
}
test('archived supplier mail is read while other integrations retain INBOX',async()=>{
  const mock=mailbox(),result=await mock.run();assert.deepEqual(mock.calls,['[Gmail]/All Mail','INBOX']);assert.equal(result.walmart.length,1);assert.equal(result.amazon.length,0);assert.equal(result.meta.walmart_complete,true);assert.ok(result.meta.walmart_scanned_through);
});
test('archive absence, supplier search failure and MIME failure prevent checkpoint advancement',async()=>{
  for(const options of [{noArchive:true},{searchFail:true},{parseFail:true}]){const result=await mailbox(options).run();assert.equal(result.meta.walmart_complete,false);assert.equal(result.meta.walmart_scanned_through,null);}
});

function dbMock(options={}) {
  const calls=[];const db={from(table){const q={select(){return q;},eq(){return q;},limit(){return q;},maybeSingle(){return q;},then(resolve,reject){
    const data=table==='bracket_purchases'?(options.rows || [{id:'purchase',business_id:'business',technician_id:'tech'}]):table==='businesses'?[{id:'business',slug:'handy-andy'}]:table==='bracket_shipping_addresses'?[]:table==='technicians'?{id:'tech',business_id:'business',active:true}:null;
    return Promise.resolve({data,error:options.readFail?Error('read failed'):null}).then(resolve,reject);
  }};return q;},async rpc(name,args){calls.push({name,args});return options.rpcFail?{error:Error('write failed')}:{data:{ok:true,status:options.status || 'synced',purchase_id:'purchase'}};}};
  return {db,calls};
}
test('API delegates receipt atomically and replays despite saved delivered status',async()=>{
  const mock=dbMock();await ingestWalmartOrder(mock.db,parse());await ingestWalmartOrder(mock.db,parse());assert.equal(mock.calls.length,2);assert.equal(mock.calls[0].name,'ingest_bracket_order');assert.equal(mock.calls[0].args.p_payload.event_id,mock.calls[1].args.p_payload.event_id);
});
test('database read/write errors fail intake instead of returning successful sync',async()=>{
  for(const options of [{readFail:true},{rpcFail:true}])await assert.rejects(ingestWalmartOrder(dbMock(options).db,parse()),/failed/);
});
test('legacy manual status-only delivery is reviewable and cannot claim a receipt',async()=>{
  const mock=dbMock({status:'review'});const result=await ingestWalmartOrder(mock.db,{walmart_order_num:number,status:'delivered'}),payload=mock.calls[0].args.p_payload;
  assert.equal(result.status,'review');assert.equal(payload.receipt_verified,false);assert.equal(payload.received,null);assert.match(payload.review_reason,/legacy/);
});
test('unassigned address produces a persisted review rather than a guessed technician',async()=>{
  const mock=dbMock({rows:[],status:'review'});await ingestWalmartOrder(mock.db,parse({text:confirmation.text+'\n123 Sample Street, Denver, CO, 80231'}));
  assert.equal(mock.calls[0].args.p_payload.technician_id,null);assert.match(mock.calls[0].args.p_payload.review_reason,/unassigned/);
});
test('cancellation payload never generates a physical stock reversal',async()=>{
  const mock=dbMock();await ingestWalmartOrder(mock.db,parse({subject:'Your order was canceled'}));const payload=mock.calls[0].args.p_payload;
  assert.equal(payload.status,'canceled');assert.equal(payload.received,null);assert.equal(payload.receipt_verified,false);
});
test('negative, fractional and missing quantity fields are rejected',async()=>{
  for(const q of [{flat:-1,tilting:0,full_motion:0},{flat:1.5,tilting:0,full_motion:0},{flat:2}])await assert.rejects(ingestWalmartOrder(dbMock().db,{...parse(),ordered:q}),/integer/);
});
test('full shipping normalization retains distinct streets and units',async()=>{
  const a=normalizeBracketShippingAddress('9600 Example St, Apt 2, Denver, CO 80231');
  assert.notEqual(a,normalizeBracketShippingAddress('9600 Other St, Apt 2, Denver, CO 80231'));
  assert.notEqual(a,normalizeBracketShippingAddress('9600 Example St, Apt 3, Denver, CO 80231'));
  assert.equal(await matchBracketShippingAddress(dbMock().db,'9600 80231'),null);
  assert.equal(validBracketShippingAddress('123 Sample Street, CO 80231'),false);
  assert.equal(validBracketShippingAddress('123 Sample Street\nDenver CO 80231'),true);
});

const health=vm.createContext({console,Date,Intl,process:{env:{}},claimOnce:async()=>false,sendSMSResult:async()=>{throw Error('No messages allowed');}});
vm.runInContext(fs.readFileSync(new URL('../api/_lib/bracket-sync-health.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/\bexport /g,''),health);
const now=new Date('2026-09-16T10:00:00Z');
function healthState(patch={}) {return {last_run_at:now.toISOString(),last_ok_at:now.toISOString(),last_walmart_distinct:1,mailboxes:{'1':{idx:1,seen_ok_ever:true,consecutive_failures:0}},misconfigured:[],last_run:{mailboxes:[{idx:1,ok:true,walmart_complete:true,walmart_archive_coverage:true,coverage_issues:[],...patch}],sync_errors:[],totals:{walmart:{events:1,synced:1}}}};}
const summary=state=>health.summarizeForDashboard({state,dispatch:{configured:true,last_tick_at:now.toISOString()}},now);
test('incomplete scans, missing archive and quantity review are never green',()=>{
  for(const patch of [{search_terms_failed:2},{parse_failures:1},{walmart_archive_coverage:false},{unparsed_walmart:1}]){const result=summary(healthState(patch));assert.equal(result.ok,false);assert.equal(result.problems[0].key,'coverage:1');}
  const state=healthState();state.last_run.totals.walmart={events:1,synced:0,review_required:1};assert.equal(summary(state).ok,false);
});
test('HTTP authorization rejections are actionable alerts',()=>{
  const state=healthState();state.last_run.sync_errors=[{action:'bracket_sync',status:401,key:number}];const result=summary(state);assert.equal(result.ok,false);assert.equal(result.problems[0].notify,true);
});
test('healthy complete persisted scan remains green',()=>{assert.equal(summary(healthState()).ok,true);});
