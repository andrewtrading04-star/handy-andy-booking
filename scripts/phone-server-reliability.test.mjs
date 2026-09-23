import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {isHoustonBooking} from '../api/_lib/houston-bonus.js';
import {hasDigits} from '../api/_lib/address.js';
import {textConsentFor} from '../api/_lib/sms.js';
import {SLOTS} from '../api/_lib/availability.js';

const source=fs.readFileSync(new URL('../api/admin.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
function cut(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Source boundary: ${start}`);return source.slice(a,b);}
const uuid='11111111-1111-4111-8111-111111111111';
const silent={log(){},warn(){},error(){}};
const response=()=>({status(code){this.code=code;return this;},json(body){this.body=JSON.parse(JSON.stringify(body));return this;}});
function database(run){
  const queries=[];
  const db={from(table){
    const q={table,op:'read',filters:[]};queries.push(q);
    const execute=()=>run(q);
    const b={select(cols){q.cols=cols;return b;},insert(row){q.op='insert';q.row=row;return b;},update(row){q.op='update';q.row=row;return b;},
      eq(k,v){q.filters.push(['eq',k,v]);return b;},neq(k,v){q.filters.push(['neq',k,v]);return b;},
      ilike(k,v){q.filters.push(['ilike',k,v]);return b;},
      in(k,v){q.filters.push(['in',k,v]);return b;},
      maybeSingle:async()=>execute(),single:async()=>execute(),then(a,z){return Promise.resolve().then(execute).then(a,z);}};
    return b;
  }};
  return {db,queries};
}
function context(extra={}){
  return vm.createContext({console:silent,Date,Set,Map,Promise,URLSearchParams,AbortController,setTimeout,clearTimeout,
    resolveBusiness:async()=>({id:'biz-1',slug:'doms',name:"Dom's"}),bail:(res,e)=>res.status(e.status||500).json({error:e.message}),
    adminAuthorName:()=> 'Office',textConsentFor,hasDigits,...extra});
}
const callSource=cut("const CALL_RESOLUTIONS =",'// Block a caller number')+
  cut('async function callLiveStart(', '// ── Click-to-call bridge')+
  cut('const CALL_EVENTS =', '// Daily + weekly rollups');
function calls(){
  const rows=new Map(),events=[];
  const f=database(q=>{
    if(q.table==='call_events'){events.push(q.row);return {data:null};}
    if(q.op==='insert'){
      const row={id:q.row.id||uuid,...q.row};
      if(rows.has(row.id))return {error:{code:'23505',message:'calls_pkey'}};
      rows.set(row.id,row);return {data:{id:row.id}};
    }
    const row=[...rows.values()].find(r=>q.filters.every(([op,k,v])=>op==='eq'?r[k]===v:r[k]!==v));
    if(q.op==='update'&&row)Object.assign(row,q.row);
    return {data:row?{...row}:null};
  });
  const ctx=context();vm.runInContext(callSource,ctx);
  return {...f,ctx,rows,events,start(body={call_id:uuid,business:'doms'},auth={role:'secretary',name:'Joey'}){const res=response();return ctx.callLiveStart({method:'POST'},res,f.db,auth,body).then(()=>res);}};
}

test('simultaneous and lost-response start retries create one durable call',async()=>{
  const f=calls();const replies=await Promise.all([f.start(),f.start(),f.start()]);
  assert.equal(f.rows.size,1);assert.ok(replies.every(r=>r.code===200&&r.body.id===uuid));
  assert.equal(replies.filter(r=>r.body.duplicate).length,2);
  f.rows.get(uuid).resolution='booked';await f.start();assert.equal(f.rows.get(uuid).resolution,'booked');
});
test('call replay cannot recover a different business or inbound row',async()=>{
  for(const row of [{id:uuid,business_id:'other',kind:'live'},{id:uuid,business_id:'biz-1',kind:'inbound'}]){
    const f=calls();f.rows.set(uuid,row);assert.equal((await f.start()).code,409);assert.equal(f.rows.size,1);
  }
});
test('owner test calls remain untracked and malformed UUIDs write nothing',async()=>{
  const f=calls();const owner=await f.start(undefined,{role:'owner'});assert.equal(owner.body.untracked,true);assert.equal(f.queries.length,0);
  assert.equal((await f.start({business:'doms',call_id:'invalid'})).code,400);assert.equal(f.queries.length,0);
});
test('missing calls return 404 instead of claiming an outcome was saved',async()=>{
  const f=calls(),r=response();await f.ctx.callUpdate({method:'POST'},r,f.db,{name:'Joey'},{id:uuid,resolution:'booked'});assert.equal(r.code,404);
});
test('call update keeps the last ten US phone digits and saves terminal status',async()=>{
  const f=calls();await f.start();const r=response();await f.ctx.callUpdate({method:'POST'},r,f.db,{name:'Joey'},{id:uuid,caller_phone:'+1 (720) 352-2206',resolution:'booked'});
  assert.equal(r.code,200);assert.equal(f.rows.get(uuid).caller_phone,'7203522206');assert.equal(f.rows.get(uuid).status,'resolved');
});
test('call update database error is surfaced',async()=>{
  const f=calls(),bad=database(()=>({error:{message:'write failed'}}));
  await assert.rejects(f.ctx.callUpdate({method:'POST'},response(),bad.db,{}, {id:uuid,notes:'x'}),e=>e.message==='write failed');
});
test('events cannot be attached to a missing or different-business call',async()=>{
  const f=calls();f.rows.set(uuid,{id:uuid,business_id:'other'});const r=response();
  await f.ctx.callEvent({method:'POST'},r,f.db,{}, {business:'doms',call_id:uuid,event:'started'});assert.equal(r.code,404);assert.equal(f.events.length,0);
});
test('event insert error objects and transport exceptions are honest failures',async()=>{
  for(const throws of [false,true]){
    const f=calls(),error=Error('event unavailable'),bad=database(q=>{if(q.op==='read')return {data:{id:uuid}};if(throws)throw error;return {error};});
    await assert.rejects(f.ctx.callEvent({method:'POST'},response(),bad.db,{}, {business:'doms',call_id:uuid,event:'started'}),e=>e===error);
  }
});
test('saved event with failed summary warns without asking to insert it again',async()=>{
  const f=calls(),bad=database(q=>q.op==='read'?{data:{id:uuid}}:q.op==='update'?{error:{message:'summary failed'}}:{data:null});const r=response();
  await f.ctx.callEvent({method:'POST'},r,bad.db,{}, {business:'doms',call_id:uuid,event:'price_quoted',meta:{total:250,tv_count:1},step:'recap'});
  assert.equal(r.code,200);assert.equal(r.body.recorded,true);assert.match(r.body.warning,/summary/);
});
test('technician selection is accepted as a call event instead of failing in the background',async()=>{
  const f=calls();await f.start();const r=response();
  await f.ctx.callEvent({method:'POST'},r,f.db,{name:'Joey'}, {business:'doms',call_id:uuid,event:'technician_picked',step:'schedule',meta:{technician_id:'one'}});
  assert.equal(r.code,200);assert.equal(f.events[0].event,'technician_picked');assert.equal(f.events[0].meta.technician_id,'one');
});

const bookingSource=cut('async function bookingCreate(', '// ── Booking update:');
function bookingStage(start,end,extra={}){
  const a=bookingSource.indexOf(start),b=bookingSource.indexOf(end,a);assert.ok(a>=0&&b>a,start);
  const f=database(()=>({data:{name:'Steve'}})),r=response();
  const ctx=context({res:r,db:f.db,biz:{id:'biz-1',slug:'doms'},effectivePostalCode:'80202',tz:'America/Denver',
    body:{technician_id:'any',require_available:true},rosterScopes:async()=>[],pickAvailableTech:async()=>null,
    pickAvailableTechPair:async()=>({primaryId:null,secondaryId:null}),pickOwnHelperPrimary:async()=>null,
    bringsOwnSecondTech:()=>false,isSecondaryIneligibleName:()=>false,resolveDefaultSecondary:async()=>null,
    batchTechSlotState:async(_db,ids)=>new Map(ids.map(id=>[id,{booked:new Set(),keys:new Set(['s5'])}])),dayOfWeekFor:()=>2,...extra});
  vm.runInContext('async function stage(){\n'+bookingSource.slice(a,b)+'\nreturn {continued:true};}',ctx);
  return {...f,ctx,r};
}
const staffingStart='  let technician_id = body.technician_id;',staffingEnd='  // Cross-metro backstop:';
test('phone bookings reject a lost slot before inserting while ordinary bookings retain unassigned behavior',async()=>{
  const phone=bookingStage(staffingStart,staffingEnd);await phone.ctx.stage();
  assert.equal(phone.r.code,409);assert.equal(phone.r.body.code,'slot_unavailable');assert.equal(phone.queries.length,0);
  const legacy=bookingStage(staffingStart,staffingEnd,{body:{technician_id:'any'}});
  assert.equal((await legacy.ctx.stage()).continued,true);assert.equal(legacy.r.code,undefined);
});
test('mandatory-helper race tells the phone to refresh slots and preserves ordinary booking status',async()=>{
  for(const phone of [true,false]){
    const f=bookingStage(staffingStart,staffingEnd,{body:{technician_id:'one',secondary_technician_id:'any',needs_lifting:true,require_available:phone}});
    await f.ctx.stage();assert.equal(f.r.code,phone?409:400);assert.equal(f.r.body.code,'slot_unavailable');
    assert.ok(f.queries.every(q=>q.op==='read'));
  }
});
test('technician profile read failures cannot change own-helper staffing decisions',async()=>{
  for(const secondary of [false,true]){
    const bad=database(q=>q.filters.some(([,key,value])=>key==='id'&&value===(secondary?'two':'one'))?{error:{message:'profile unavailable'}}:{data:{name:'Steve'}});
    const f=bookingStage(staffingStart,staffingEnd,{db:bad.db,body:{technician_id:'one',secondary_technician_id:secondary?'two':null}});
    await assert.rejects(f.ctx.stage(),e=>e.message==='profile unavailable');
  }
});
test('primary and secondary occupancy conflicts return the same slot refresh code',async()=>{
  for(const busy of ['one','two']){
    const f=bookingStage('  if (scheduled_at && (technician_id || secondary_technician_id)) {','  const paymentMethod =',{
      scheduled_at:'2026-09-16T01:00:00Z',technician_id:'one',secondary_technician_id:'two',body:{scheduled_date:'2026-09-15',scheduled_slot:'s5'},
      batchTechSlotState:async(_db,ids)=>new Map(ids.map(id=>[id,{booked:new Set(id===busy?['s5']:[]),keys:new Set(['s5'])}]))});
    await f.ctx.stage();assert.equal(f.r.code,409);assert.equal(f.r.body.code,'slot_unavailable');
  }
});
test('a scheduled-tech override still uses tech_unavailable instead of a slot collision',async()=>{
  const f=bookingStage('  if (scheduled_at && (technician_id || secondary_technician_id)) {','  const paymentMethod =',{
    scheduled_at:'2026-09-16T01:00:00Z',technician_id:'one',secondary_technician_id:null,body:{scheduled_date:'2026-09-15',scheduled_slot:'s5'},batchTechSlotState:async()=>new Map([['one',{booked:new Set(),keys:new Set()}]])});
  await f.ctx.stage();assert.equal(f.r.code,409);assert.equal(f.r.body.code,'tech_unavailable');assert.equal(f.r.body.tech_id,'one');
});
test('an explicit schedule override cannot waive a collision on either technician',async()=>{
  for(const busy of ['one','two']){
    const f=bookingStage('  if (scheduled_at && (technician_id || secondary_technician_id)) {','  const paymentMethod =',{
      scheduled_at:'2026-09-16T01:00:00Z',technician_id:'one',secondary_technician_id:'two',body:{scheduled_date:'2026-09-15',scheduled_slot:'s5',force_unavailable_ids:['one','two']},
      batchTechSlotState:async(_db,ids)=>new Map(ids.map(id=>[id,{booked:new Set(id===busy?['s5']:[]),keys:new Set()}]))});
    await f.ctx.stage();assert.equal(f.r.code,409);assert.equal(f.r.body.code,'slot_unavailable');
  }
});
test('failed final availability check rejects the booking even after assignment succeeded',async()=>{
  const f=bookingStage('  if (scheduled_at && (technician_id || secondary_technician_id)) {','  const paymentMethod =',{
    scheduled_at:'2026-09-16T01:00:00Z',technician_id:'one',secondary_technician_id:null,body:{scheduled_date:'2026-09-15',scheduled_slot:'s5'},
    batchTechSlotState:async()=>{throw Error('Schedule offline');}});
  await assert.rejects(f.ctx.stage(),/Schedule offline/);assert.equal(f.r.code,undefined);
});
test('the database final slot collision also asks the phone to refresh availability',async()=>{
  const f=bookingStage("    if (bErr.code === '23505' && /bookings_tech_slot_unique/",'    const missing =',{
    bErr:{code:'23505',message:'duplicate key violates constraint bookings_tech_slot_unique'}});
  await f.ctx.stage();assert.equal(f.r.code,409);assert.equal(f.r.body.code,'slot_unavailable');
});
test('booking replay returns the existing booking before customer/payment side effects',async()=>{
  const ctx=context();vm.runInContext(bookingSource,ctx);const f=database(()=>({data:{id:'booking-1',status:'confirmed'}})),r=response();
  await ctx.bookingCreate({method:'POST'},r,f.db,{}, {business:'doms',customer:{name:'Caller'},idempotency_key:'same-attempt'});
  assert.equal(r.body.id,'booking-1');assert.equal(r.body.duplicate,true);assert.equal(f.queries.length,1);assert.match(r.body.warning,/Check the saved job/);
});
test('cancelled booking replay explicitly requires a new attempt',async()=>{
  const ctx=context();vm.runInContext(bookingSource,ctx);const f=database(()=>({data:{id:'booking-1',status:'cancelled'}})),r=response();
  await ctx.bookingCreate({method:'POST'},r,f.db,{}, {business:'doms',customer:{name:'Caller'},idempotency_key:'same-attempt'});
  assert.equal(r.code,409);assert.equal(r.body.code,'booking_cancelled');assert.equal(f.queries.length,1);
});
test('a failed booking replay check cannot fall through to another insert',async()=>{
  const ctx=context();vm.runInContext(bookingSource,ctx);const f=database(()=>({error:{message:'DB unavailable'}}));
  await assert.rejects(ctx.bookingCreate({method:'POST'},response(),f.db,{}, {business:'doms',customer:{name:'Caller'},idempotency_key:'same'}),e=>e.message==='DB unavailable');
  assert.equal(f.queries.length,1);
});
test('failed customer matching cannot create a duplicate customer during phone booking',async()=>{
  for(const field of ['phone','email']){
    const ctx=context();vm.runInContext(bookingSource,ctx);const error={message:'customer lookup unavailable'},f=database(()=>({error}));
    await assert.rejects(ctx.bookingCreate({method:'POST'},response(),f.db,{}, {customer:{name:'Caller',[field]:'test'}}),e=>e===error);
    assert.equal(f.queries.length,1);assert.equal(f.queries[0].op,'read');
  }
});
function bookingFinish(extra={}){
  const end=bookingSource.slice(bookingSource.indexOf('  if (bErr) throw bErr;'));
  const f=database(()=>({data:{id:'booking-1'}}));const r=response();
  const ctx=context({bErr:null,bRow:{id:'booking-1'},unassignedWarning:null,res:r,db:f.db,auth:{role:'owner'},body:{selections:[]},c:{},biz:{id:'biz-1',slug:'doms'},
    paymentMethod:'cash',technician_id:null,secondary_technician_id:null,scheduled_at:null,status:'confirmed',tz:'America/Denver',primaryTechInfo:null,
    ensureReviewToken:async()=>{},saveCardOnFile:async()=>({customerId:'cus_1',pmId:'pm_1'}),canonicalizeLineItems:x=>x,isSortOrderErr:()=>false,
    maybeSendBigBracketAlert(){},maybeSendZeroOrLowProfitAlert(){},emailNotificationsOn:()=>false,process:{env:{}},...extra});
  vm.runInContext('async function finish(){\n'+end,ctx);
  return {...f,ctx,r};
}
test('a failure after the booking row exists still returns its id and a warning',async()=>{
  const f=bookingFinish({ensureReviewToken:async()=>{throw Error('token write failed');}});await f.ctx.finish();
  assert.equal(f.r.code,200);assert.equal(f.r.body.id,'booking-1');assert.match(f.r.body.warning,/Booking was created/);
});
test('an otherwise completed booking remains successful without a warning',async()=>{
  const f=bookingFinish();await f.ctx.finish();assert.equal(f.r.code,200);assert.equal(f.r.body.id,'booking-1');assert.equal(f.r.body.warning,undefined);
});
test('missing card configuration and failed card linkage both warn on the saved booking',async()=>{
  for(const missingConfig of [true,false]){
    const db=database(q=>q.op==='update'?{error:{message:'link failed'}}:{data:null}).db;
    const f=bookingFinish({db,paymentMethod:'card',body:{payment_method_id:'pm_1',selections:[]},saveCardOnFile:async()=>missingConfig?null:{customerId:'cus_1',pmId:'pm_1'}});
    await f.ctx.finish();assert.equal(f.r.body.id,'booking-1');assert.match(f.r.body.warning,/card could not be saved/);
  }
});
test('thrown line-item persistence cannot turn a saved booking into failed create',async()=>{
  const db=database(q=>{if(q.table==='booking_line_items')throw Error('network lost');return {data:null};}).db;
  const f=bookingFinish({db,body:{selections:[{label:'Mounting',quantity:1,price:150}]}});await f.ctx.finish();assert.equal(f.r.body.id,'booking-1');assert.match(f.r.body.warning,/setup did not finish/);
});

function notificationFinish(extra={}){
  const pending=new Map();
  const gate=name=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});pending.set(name,{resolve,reject});return promise;};
  const db=database(q=>({data:q.table==='technicians'?[{id:'one',name:'Steve'},{id:'two',name:'TK'}]:null})).db;
  const f=bookingFinish({db,SLOTS,smsConsent:true,c:{name:'Test Caller',phone:'2025550147',email:'test@example.test'},
    auth:{role:'secretary',name:'Test'},technician_id:'one',secondary_technician_id:'two',scheduled_at:'2026-10-05T14:00:00Z',
    body:{selections:[],scheduled_date:'2026-10-05',scheduled_slot:'s1'},bookingConfirmMessage:()=> 'Your booking is confirmed',
    sendSMSResult:()=>gate('customer'),logAutomatedMessage:()=>gate('sms-log'),notifyTechAssigned:(_db,_biz,id)=>gate(id),
    bookingConfirmationEmail:()=>({subject:'Confirmed',html:'fixture'}),gdsUpsellUrlFor:()=>null,rescheduleUrlFor:()=>null,brandFor:()=>({}),emailConfig:()=>({from:'test@example.test'}),
    sendEmail:()=>gate('email'),persistConfirmationEmailStatus:()=>gate('email-status'),sendOwnerBookingAlert:()=>gate('owner'),...extra});
  return {...f,pending};
}
test('booking notifications start together and response waits for every send and delivery log',async()=>{
  const f=notificationFinish(),run=f.ctx.finish();await new Promise(r=>setImmediate(r));
  assert.deepEqual([...f.pending.keys()].sort(),['customer','email','one','owner','two']);assert.equal(f.r.code,undefined);
  f.pending.get('customer').resolve({ok:true});f.pending.get('email').resolve({sent:true});await new Promise(r=>setImmediate(r));
  assert(f.pending.has('sms-log'));assert(f.pending.has('email-status'));
  for(const name of ['one','two','owner','email-status'])f.pending.get(name).resolve({ok:true});
  await new Promise(r=>setImmediate(r));assert.equal(f.r.code,undefined,'customer delivery log is still unfinished');
  f.pending.get('sms-log').resolve();await run;assert.equal(f.r.code,200);assert.equal(f.r.body.warning,undefined);
});
test('one failed notification cannot release the response while other deliveries are still running',async()=>{
  const f=notificationFinish({persistConfirmationEmailStatus:async()=>{throw Error('status offline');}}),run=f.ctx.finish();
  await new Promise(r=>setImmediate(r));f.pending.get('email').resolve({sent:true});
  await new Promise(r=>setImmediate(r));assert.equal(f.r.code,undefined);
  for(const name of ['customer','one','two','owner'])f.pending.get(name).resolve({ok:true});
  await new Promise(r=>setImmediate(r));assert.equal(f.r.code,undefined);f.pending.get('sms-log').resolve();
  await run;assert.equal(f.r.code,200);assert.equal(f.r.body.id,'booking-1');assert.match(f.r.body.warning,/notifications/);
});

const estimateSource=cut('function normalizeTaxRate(', '// Normalize quote line items')+
  cut('async function insertEstimateResilient(', '// Sum of qty')+cut('async function estimateCreate(', '// Send quote SMS');
function estimates(extra={}){
  const rows=new Map(),sent=[];
  const f=database(q=>{
    if(q.op==='insert'){
      if(rows.has(q.row.id))return {error:{code:'23505',message:'estimates_pkey'}};
      rows.set(q.row.id,{...q.row});return {data:{id:q.row.id}};
    }
    const row=[...rows.values()].find(r=>q.filters.every(([,k,v])=>r[k]===v));return {data:row||null};
  });
  const ctx=context({PHONE_REQUEST_UUID:/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i,sanitizeLineItems:x=>x,sanitizeUpsells:()=>[],priceSanityIssue:()=>null,
    emailNotificationsOn:()=>true,emailConfig:()=>({apiKey:'test'}),process:{env:{PUBLIC_URL:'https://test.invalid'}},signToken:()=> 'signed',brandFor:()=>({}),estimateEmail:x=>({subject:'Estimate',html:JSON.stringify(x)}),
    sendEmail:async args=>sent.push(args),markEstimateContacted:async()=>{},sendOptInConfirmSms:async()=>{},sendSMSResult:async()=>({ok:false}),quoteTotals:()=>({total:100}),smsBrandName:()=>"Dom's",publicUpsells:x=>x,logAutomatedMessage:async()=>{},...extra});
  vm.runInContext(cut('function missingColumn(', '// ── Dashboard summary')+estimateSource,ctx);
  const body={business:'doms',estimate_id:uuid,customer_email:'test@example.test',customer_name:'Test',selections:[{label:'Mount',quantity:1,price:100}],tax_rate:.0825};
  return {...f,ctx,rows,sent,body,async run(payload=body){const r=response();await ctx.estimateCreate({method:'POST'},r,f.db,{name:'Joey'},payload);return r;}};
}
test('estimate replay creates and sends once even when the original response is lost',async()=>{
  const f=estimates();const first=await f.run(),second=await f.run();
  assert.equal(first.body.id,uuid);assert.equal(first.body.emailed,true);assert.equal(second.body.duplicate,true);assert.equal(second.body.delivery_unknown,true);assert.equal(f.rows.size,1);assert.equal(f.sent.length,1);
});
test('concurrent estimate requests produce one saved row and one send',async()=>{
  const f=estimates();const results=await Promise.all([f.run(),f.run()]);assert.equal(f.rows.size,1);assert.equal(f.sent.length,1);assert.equal(results.filter(r=>r.body.duplicate).length,1);
});
test('estimate delivery setup failure still returns the persisted estimate id',async()=>{
  const f=estimates({estimateEmail:()=>{throw Error('template failed');}});const r=await f.run();
  assert.equal(r.body.id,uuid);assert.equal(r.body.delivery_unknown,true);assert.equal(f.rows.size,1);assert.equal(f.sent.length,0);
});
test('estimate explicit tax and legacy default remain consistent in row and email',async()=>{
  for(const tax of [undefined,0,.0825,8.75]){
    const f=estimates(),r=await f.run({...f.body,tax_rate:tax});assert.equal(r.code,201);
    const wanted=tax===undefined?.0825:tax>1?tax/100:tax;
    assert.equal(f.rows.get(uuid).tax_rate,wanted);assert.equal(JSON.parse(f.sent[0].html).taxRate,wanted);
  }
});
test('estimate collision in another business is rejected without disclosure or send',async()=>{
  const f=estimates();f.rows.set(uuid,{id:uuid,business_id:'other'});const r=await f.run();assert.equal(r.code,409);assert.equal(f.sent.length,0);
});
test('phone estimates never drop saved quote amounts to tolerate a missing schema column',async()=>{
  for(const column of ['line_items','tax_rate','id']){
    const f=estimates(),bad=database(()=>({error:{code:'42703',message:`column estimates.${column} does not exist`}}));
    await assert.rejects(f.ctx.estimateCreate({method:'POST'},response(),bad.db,{},f.body),e=>e.code==='42703');
    assert.equal(bad.queries.length,1);assert.equal(f.sent.length,0);
  }
});
test('a malformed estimate insert response cannot send a broken approval link',async()=>{
  const f=estimates(),db=database(()=>({data:{}})).db,r=response();
  await f.ctx.estimateCreate({method:'POST'},r,db,{},f.body);
  assert.equal(r.code,500);assert.equal(f.sent.length,0);assert.match(r.body.error,/same estimate attempt/);
});
test('estimate compatibility only drops a verified absent optional column',async()=>{
  for(const code of ['57014','42703']){
    let reads=0;const f=estimates(),db=database(()=>++reads===1?{error:{code,message:'column estimates.upsells does not exist'}}:{data:{id:uuid}}).db;
    const result=await f.ctx.insertEstimateResilient(db,{id:uuid,upsells:[]},['id']);
    assert.equal(reads,code==='42703'?2:1);assert.equal(result.error?.code,code==='42703'?undefined:code);
  }
});

const cardSource=cut('async function saveCardOnFile(', '// ── Price sanity ceiling');
test('card storage rejects a failed default-card response instead of reporting success',async()=>{
  let n=0;const ctx=context({businessSecretKey:()=> 'test-key',fetch:async()=>{n++;return {ok:n<3,json:async()=>n===1?{id:'cus_1'}:n===2?{id:'pm_1'}:{error:{message:'default failed'}}};}});
  vm.runInContext(cardSource,ctx);await assert.rejects(ctx.saveCardOnFile('pm_1',{},'doms'),/default failed/);assert.equal(n,3);
});
test('card processor timeout includes a response body that never finishes',async()=>{
  let aborted=false;const ctx=context({businessSecretKey:()=> 'test-key',setTimeout:fn=>setTimeout(fn,10),fetch:async(_url,{signal})=>({ok:true,json:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;const e=Error('abort');e.name='AbortError';reject(e);} ))})});
  vm.runInContext(cardSource,ctx);await assert.rejects(ctx.saveCardOnFile('pm_1',{},'doms'),/Stripe request timed out/);assert.equal(aborted,true);
});

test('quote discount ceiling cannot make a normal paid booking fail the same minimum',async()=>{
  const ctx=context({MIN_TICKET_PRICE:139,normalizeTaxRate:r=>Number(r),DEFAULT_EST_TAX_RATE:.0825,
    serviceAreaIdFromPostal:async()=> 'denver',isHoustonBooking:async()=>false,computeJobPay:()=>({pay:0,flags:[]}),bracketHardwareCost:()=>0});
  const minimumHelper=source.includes('function isHandymanPricedLines(')?cut('function isHandymanPricedLines(', '// Returns null when'):'';
  vm.runInContext(minimumHelper+cut('const QUOTE_PROFIT_FLOOR =', '// ── Take a Call: event log'),ctx);
  for(const tax of [0,.0825]){
    const r=response();await ctx.quoteEconomics({method:'POST'},r,{}, {role:'secretary'}, {business:'doms',tax_rate:tax,line_items:[{name:'TV mounting',quantity:1,line_total:139}]});
    const afterDiscount=139-r.body.max_discount;
    assert.ok(Math.round(afterDiscount*(1+tax)*100)/100>=139,`The allowed discount ${r.body.max_discount} must leave a bookable ticket`);
  }
  const hm=response();await ctx.quoteEconomics({method:'POST'},hm,{}, {}, {business:'doms',tax_rate:0,line_items:[{name:'Handyman Labor: shelves',line_total:139}]});
  assert.equal(hm.body.max_discount,20,'hourly handyman exemption matches booking_create');
});

const bookSource=fs.readFileSync(new URL('../api/book.js',import.meta.url),'utf8');
const couponSource=bookSource.slice(bookSource.indexOf('const COUPON_TTL_MS'),bookSource.indexOf('// The multi-TV discount used to')).replaceAll('export ','');
test('phone coupon checks refuse an unverified public fallback cache',async()=>{
  const ctx=context({DOMS_COUPONS:{RETIRED:15},NATIVE_COUPONS:{}});vm.runInContext(couponSource,ctx);
  const bad=database(q=>q.table==='businesses'?{data:{id:'biz-1'}}:{error:{message:'coupon DB offline'}});
  assert.equal(await ctx.couponAmountFor(bad.db,'doms','RETIRED'),15,'public compatibility fallback');
  await assert.rejects(ctx.couponAmountFor(bad.db,'doms','RETIRED',{strict:true}),e=>e.message==='coupon DB offline');
});
test('verified empty coupons do not resurrect a retired hardcoded coupon',async()=>{
  const ctx=context({DOMS_COUPONS:{RETIRED:15},NATIVE_COUPONS:{}});vm.runInContext(couponSource,ctx);
  const db=database(q=>q.table==='businesses'?{data:{id:'biz-1'}}:{data:[]}).db;
  assert.equal(await ctx.couponAmountFor(db,'doms','RETIRED',{strict:true}),0);assert.equal((await ctx.couponCodesFor(db,'doms',{strict:true})).length,0);
});
test('verified coupon reads are cached and preserve the current amount',async()=>{
  const ctx=context({DOMS_COUPONS:{},NATIVE_COUPONS:{}});vm.runInContext(couponSource,ctx);
  const f=database(q=>q.table==='businesses'?{data:{id:'biz-1'}}:{data:[{code:'CURRENT',amount:12.5,active:true}]});
  assert.equal(await ctx.couponAmountFor(f.db,'doms',' current ',{strict:true}),12.5);
  assert.equal((await ctx.couponCodesFor(f.db,'doms',{strict:true}))[0],'CURRENT');assert.equal(f.queries.length,2);
});

test('Houston pricing lookup errors are never cached as a non-Houston job',async()=>{
  for(const throws of [false,true]){
    let reads=0;const error=Error('Houston lookup unavailable'),f=database(()=>{reads++;if(reads>1)return {data:{id:'houston'}};if(throws)throw error;return {error};});
    const biz='test-retry-houston-'+throws;
    await assert.rejects(isHoustonBooking(f.db,biz,'handyandy','houston'),e=>e===error);
    assert.equal(await isHoustonBooking(f.db,biz,'handyandy','houston'),true);
    assert.equal(await isHoustonBooking(f.db,biz,'handyandy','denver'),false);assert.equal(reads,2);
  }
});
