import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {SLOTS,dayOfWeekFor} from '../api/_lib/availability.js';
import {localDateStartUTC,addDaysStr} from '../api/_lib/time.js';

const source=fs.readFileSync(new URL('../api/admin.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
function fn(name){const re=new RegExp('^(?:async )?function '+name+'\\(','m'),a=source.search(re),b=source.indexOf('\n}\n',a);assert.ok(a>=0&&b>a,name);return source.slice(a,b+3);}
const result=()=>({status(code){this.code=code;return this;},json(body){this.body=JSON.parse(JSON.stringify(body));return this;}});
function dbFor(handler){const queries=[];return {queries,from(table){const q={table,filters:[]};queries.push(q);const b={};
  for(const key of ['select','eq','neq','not','gte','lt','lte','or','in','order'])b[key]=(...args)=>{q.filters.push([key,...args]);return b;};
  b.maybeSingle=async()=>handler(q);b.then=(a,z)=>Promise.resolve().then(()=>handler(q)).then(a,z);return b;}};}
function setup({now='2026-09-16T00:30:00Z',timezone='America/Denver',rows=[],exceptions=[],bookings=[],techs=[{id:'tech-1',name:'Steve'}],failTable=null,extra={}}={}){
  const FixedDate=class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();}};
  const db=dbFor(q=>q.table===failTable?{error:{message:'database failed '+q.table}}:{data:q.table==='technician_availability'?rows:q.table==='technician_availability_exceptions'?exceptions:q.table==='bookings'?bookings:q.table==='service_areas'?{name:'Denver',unstaffed:false}:[]});
  const ctx=vm.createContext({Date:FixedDate,Intl,Set,Map,Promise,SLOTS,dayOfWeekFor,localDateStartUTC,addDaysStr,
    resolveBusiness:async()=>({id:'biz-1',slug:'doms',timezone}),bail:(res,e)=>res.status(e.status||500).json({error:e.message}),
    serviceAreaIdFromPostal:async()=> 'area-1',areaTimezone:async()=>timezone,rosterScopes:async()=>[{bizId:'biz-1',serviceAreaId:'area-1'}],
    scopedRosterTechs:async()=>[techs],isSecondaryIneligibleName:name=>['juan','zach'].includes(String(name).toLowerCase()),
    bringsOwnSecondTech:name=>['juan','zach'].includes(String(name).toLowerCase()),
    bookingLiftCols:true,extraSlotsCol:true,esCol:()=>'',esOf:()=>[],isExtraSlotsErr:()=>false,
    console:{warn(){}},...extra});
  vm.runInContext(['missingColumn','localHHMM','localDateStr','slotKeyForLocalTime','availableDates','availableSlots','batchTechSlotState'].map(fn).join('\n'),ctx);
  return {db,ctx,async dates(query={}){const r=result();await ctx.availableDates({query:{business:'doms',month:'2026-09',technician_id:'any',postal_code:'80202',...query}},r,db,{});return r;},
    async slots(date='2026-09-15',query={}){const r=result();await ctx.availableSlots({query:{business:'doms',date,technician_id:'any',postal_code:'80202',...query}},r,db,{});return r;}};
}
test('US local today remains bookable after UTC midnight and timezone is returned',async()=>{
  const f=setup({rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});const r=await f.dates();
  assert.ok(r.body.dates.includes('2026-09-15'));assert.equal(r.body.timezone,'America/Denver');
});
test('today disappears once every available slot has already started',async()=>{
  const f=setup({now:'2026-09-16T03:00:00Z',rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});const r=await f.dates();
  assert.ok(!r.body.dates.includes('2026-09-15'));assert.ok(r.body.dates.includes('2026-09-22'));
});
test('past dates return no slots without fetching a roster',async()=>{
  const f=setup({extra:{rosterScopes:()=>{throw Error('must not fetch a past roster');}}});const r=await f.slots('2026-09-14');
  assert.deepEqual(r.body.slots,[]);assert.equal(r.body.timezone,'America/Denver');
});
test('today slot list keeps future starts only using the metro clock',async()=>{
  const state={techs:[],state:new Map()};const f=setup({extra:{rosterSlotState:async()=>state,freeKeysFromState:()=>new Set(['s1','s4','s5']),freeTechsByKeyFromState:()=>({})}});
  const r=await f.slots();assert.deepEqual(r.body.slots.map(s=>s.slot_key),['s5']);assert.equal(r.body.timezone,'America/Denver');
});
test('the calendar excludes primary-only technicians from the secondary side',async()=>{
  const f=setup({techs:[{id:'tech-1',name:'Juan'}],rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});
  const r=await f.dates({technician_id:'other-primary',secondary_technician_id:'any'});assert.deepEqual(r.body.dates,[]);assert.equal(r.body.timezone,'America/Denver');
});
test('calendar pairing requires two distinct eligible people in the same slot',async()=>{
  const rows=[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}];
  const f=setup({rows});const one=await f.dates({secondary_technician_id:'any'});assert.ok(!one.body.dates.includes('2026-09-15'));
  const two=setup({rows:[...rows,{technician_id:'tech-2',day_of_week:2,slot_key:'s5'}],techs:[{id:'tech-1',name:'Steve'},{id:'tech-2',name:'Gregory'}]});
  assert.ok((await two.dates({secondary_technician_id:'any'})).body.dates.includes('2026-09-15'));
});
for(const table of ['technician_availability','technician_availability_exceptions','bookings']){
  test(`failed ${table} read cannot be advertised as free calendar dates`,async()=>{
    const f=setup({failTable:table,rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});await assert.rejects(f.dates(),e=>e.message==='database failed '+table);
  });
  test(`failed ${table} read cannot be advertised as free technician slots`,async()=>{
    const f=setup({failTable:table});await assert.rejects(f.ctx.batchTechSlotState(f.db,['tech-1'],'2026-09-15',2,'America/Denver'),e=>e.message==='database failed '+table);
  });
}
test('a failed legacy occupancy fallback still fails closed',async()=>{
  let reads=0;const f=setup();f.db=dbFor(q=>q.table==='bookings'?(++reads===1?{error:{code:'42703',message:'column secondary_technician_id does not exist'}}:{error:{message:'fallback failed'}}):{data:[]});
  await assert.rejects(f.ctx.batchTechSlotState(f.db,['tech-1'],'2026-09-15',2,'America/Denver'),e=>e.message==='fallback failed');assert.equal(reads,2);
});

test('a transient secondary occupancy error cannot disable helper collision checks for later requests',async()=>{
  for(const mode of ['batch','single','dates']){
    let reads=0;const f=setup();vm.runInContext(fn('bookedSlotKeysForTech'),f.ctx);
    const error={code:'57014',message:'query cancelled while reading secondary_technician_id'};
    const bad=dbFor(q=>q.table==='bookings'?(reads++,{error}):{data:[]});
    const action=mode==='batch'?()=>f.ctx.batchTechSlotState(bad,['tech-1'],'2026-09-15',2,'America/Denver'):
      mode==='single'?()=>f.ctx.bookedSlotKeysForTech(bad,'biz-1','tech-1','2026-09-15','America/Denver'):
      ()=>f.ctx.availableDates({query:{month:'2026-09',technician_id:'any',postal_code:'80202'}},result(),bad,{});
    await assert.rejects(action(),e=>e===error);assert.equal(reads,1);assert.equal(f.ctx.bookingLiftCols,true);
  }
});

test('verified legacy missing secondary column can still use the primary-only occupancy read',async()=>{
  for(const mode of ['batch','single','dates']){
    let reads=0;const f=setup();vm.runInContext(fn('bookedSlotKeysForTech'),f.ctx);
    const bad=dbFor(q=>q.table==='bookings'&&++reads===1?{error:{code:'42703',message:'column bookings.secondary_technician_id does not exist'}}:{data:[]});
    if(mode==='batch')await f.ctx.batchTechSlotState(bad,['tech-1'],'2026-09-15',2,'America/Denver');
    else if(mode==='single')await f.ctx.bookedSlotKeysForTech(bad,'biz-1','tech-1','2026-09-15','America/Denver');
    else await f.ctx.availableDates({query:{month:'2026-09',technician_id:'any',postal_code:'80202'}},result(),bad,{});
    assert.equal(reads,2);assert.equal(f.ctx.bookingLiftCols,false);
  }
});
test('service area errors do not become an unmapped ZIP',async()=>{
  const f=setup();vm.runInContext(fn('zip5')+fn('serviceAreaIdFromPostal'),f.ctx);
  await assert.rejects(f.ctx.serviceAreaIdFromPostal(dbFor(()=>({error:{message:'zip unavailable'}})),'biz-1','80202'),e=>e.message==='zip unavailable');
});
test('timezone failure cannot silently schedule in another metro clock',async()=>{
  const f=setup();vm.runInContext(fn('missingColumn')+fn('areaTimezone'),f.ctx);
  await assert.rejects(f.ctx.areaTimezone(dbFor(()=>({error:{message:'timeout'}})),'area-1','America/Denver'),e=>e.message==='timeout');
  const legacy=await f.ctx.areaTimezone(dbFor(()=>({error:{code:'42703',message:'column service_areas.timezone does not exist'}})),'area-1','America/Denver');assert.equal(legacy,'America/Denver');
});
test('failed roster lookup cannot turn into an empty available roster',async()=>{
  const f=setup({extra:{applySoleTech:(_biz,list)=>list}});vm.runInContext(fn('normalizeRosterScopes')+fn('scopedRosterTechs'),f.ctx);
  await assert.rejects(f.ctx.scopedRosterTechs(dbFor(()=>({error:{message:'roster unavailable'}})),[{bizId:'biz-1',serviceAreaId:'area-1'}]),e=>e.message==='roster unavailable');
});

test('explicit lifting requests include an available primary who brings their own helper',async()=>{
  const f=setup({techs:[{id:'tech-1',name:'Juan'}],rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});
  assert.ok(!(await f.dates({secondary_technician_id:'any'})).body.dates.includes('2026-09-15'));
  assert.ok((await f.dates({secondary_technician_id:'any',needs_lifting:'1'})).body.dates.includes('2026-09-15'));
});
test('own-helper slot discovery reuses the primary state and never broadens generic pair requests',async()=>{
  let reads=0;const state={techs:[{id:'tech-1',name:'Zach'}],state:new Map([['tech-1',{keys:new Set(['s5']),booked:new Set()}]])};
  const f=setup({extra:{rosterSlotState:async()=>{reads++;return state;},freeSlotTechMap:()=>{throw Error('duplicate roster read');}}});
  vm.runInContext(['freeMapFromState','freeKeysFromState','freeTechsByKeyFromState'].map(fn).join('\n'),f.ctx);
  assert.deepEqual((await f.slots('2026-09-15',{secondary_technician_id:'any',pool:'own',pool2:'own'})).body.slots,[]);
  assert.deepEqual((await f.slots('2026-09-15',{secondary_technician_id:'any',pool:'own',pool2:'own',needs_lifting:'1'})).body.slots.map(s=>s.slot_key),['s5']);
  assert.equal(reads,2,'one combined roster/state read per request');
});
test('calendar pair requests share the same-pool roster query',async()=>{
  let reads=0;const f=setup({extra:{scopedRosterTechs:async()=>{reads++;return [[{id:'one',name:'Steve'},{id:'two',name:'Gregory'}]];}}});
  await f.dates({secondary_technician_id:'any',pool:'own',pool2:'own'});assert.equal(reads,1);
});

test('selected own-helper primary remains available for lifting without another roster technician',async()=>{
  for(const name of ['Juan','Zach']){
    const f=setup({techs:[{id:'tech-1',name}],rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});
    const r=await f.dates({technician_id:'tech-1',secondary_technician_id:'any',pool:'own',pool2:'own',needs_lifting:'1',include_slots:'1',strict_roster:'1'});
    assert.ok(r.body.dates.includes('2026-09-15'));assert.deepEqual(r.body.slots_by_date['2026-09-15'].map(s=>s.slot_key),['s5']);
  }
});

test('selecting a different primary never borrows the own-helper technicians availability',async()=>{
  const f=setup({techs:[{id:'tech-1',name:'Steve'},{id:'tech-2',name:'Juan'}],rows:[{technician_id:'tech-2',day_of_week:2,slot_key:'s5'}]});
  const r=await f.dates({technician_id:'tech-1',secondary_technician_id:'any',pool:'own',pool2:'own',needs_lifting:'1',include_slots:'1',strict_roster:'1'});
  assert.deepEqual(r.body.dates,[]);assert.deepEqual(r.body.slots_by_date,{});
});

test('bundled calendar has exact selected-tech slots and excludes occupied primary and helper slots',async()=>{
  const techs=[{id:'tech-1',name:'Steve'},{id:'tech-2',name:'Gregory'}];
  const rows=techs.flatMap(t=>['s1','s2','s3'].map(slot_key=>({technician_id:t.id,day_of_week:3,slot_key})));
  const f=setup({techs,rows,bookings:[{technician_id:'tech-1',scheduled_at:'2026-09-16T14:00:00Z'},{technician_id:'other',secondary_technician_id:'tech-1',scheduled_at:'2026-09-16T17:00:00Z'}]});
  const selected=await f.dates({technician_id:'tech-1',include_slots:'1',strict_roster:'1'});
  assert.deepEqual(selected.body.slots_by_date['2026-09-16'].map(s=>s.slot_key),['s3']);
  const auto=await f.dates({include_slots:'1',strict_roster:'1'});
  assert.deepEqual(auto.body.slots_by_date['2026-09-16'].map(s=>s.slot_key),['s1','s2','s3']);
  const pair=await f.dates({include_slots:'1',secondary_technician_id:'any'});
  assert.deepEqual(pair.body.slots_by_date['2026-09-16'].map(s=>s.slot_key),['s3']);
  assert.deepEqual(selected.body.technicians,techs);
});

test('phone calendar refuses a selected technician outside its server roster',async()=>{
  const f=setup({rows:[{technician_id:'outside',day_of_week:2,slot_key:'s5'}]});
  const r=await f.dates({technician_id:'outside',include_slots:'1',strict_roster:'1'});
  assert.deepEqual(r.body.dates,[]);assert.equal(r.body.reason,'technician_unavailable');
  assert.equal(f.db.queries.filter(q=>q.table==='bookings').length,0);
});

test('phone roster and availability exclude technicians switched off without broadening a selected technician',async()=>{
  const f=setup({techs:[{id:'tech-1',name:'Juan',status:'off'}],rows:[{technician_id:'tech-1',day_of_week:2,slot_key:'s5'}]});
  for(const id of ['any','tech-1']){
    const r=await f.dates({technician_id:id,include_slots:'1',strict_roster:'1'});
    assert.deepEqual(r.body.technicians,[]);assert.deepEqual(r.body.dates,[]);
  }
});

test('selected technician times reuse one roster state and allow only that technicians own helper',async()=>{
  const techs=[{id:'tech-1',name:'Juan'},{id:'tech-2',name:'Steve'}];
  const state=new Map([['tech-1',{keys:new Set(['s5']),booked:new Set()}],['tech-2',{keys:new Set(),booked:new Set()}]]);
  let reads=0;const f=setup({extra:{rosterSlotState:async()=>{reads++;return {techs,state};},availableSlotKeys:()=>{throw Error('duplicate query');},freeSlotTechMap:()=>{throw Error('duplicate query');}}});
  vm.runInContext(['freeMapFromState','freeKeysFromState','freeTechsByKeyFromState'].map(fn).join('\n'),f.ctx);
  for(const id of ['tech-1','tech-2','outside']){
    const r=await f.slots('2026-09-15',{technician_id:id,secondary_technician_id:'any',pool:'own',pool2:'own',needs_lifting:'1',strict_roster:'1'});
    assert.deepEqual(r.body.slots.map(s=>s.slot_key),id==='tech-1'?['s5']:[]);
  }
  assert.equal(reads,3);
});

test('recurring, exceptions and bookings start together without a serial occupancy round trip',async()=>{
  const started=[],pending=[];const f=setup();
  const db=dbFor(q=>new Promise(resolve=>{started.push(q.table);pending.push(resolve);}));
  const result=f.ctx.batchTechSlotState(db,['tech-1'],'2026-09-15',2,'America/Denver');
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.deepEqual(new Set(started),new Set(['technician_availability','technician_availability_exceptions','bookings']));
  pending.forEach(resolve=>resolve({data:[]}));await result;
});
test('booking own-helper fallback picks an available helper owner rather than another free single tech',async()=>{
  const f=setup({extra:{rosterSlotState:async()=>({techs:[{id:'steve',name:'Steve'},{id:'busy-juan',name:'Juan'},{id:'zach',name:'Zach'}],
    state:new Map([['steve',{keys:new Set(['s5']),booked:new Set()}],['busy-juan',{keys:new Set(['s5']),booked:new Set(['s5'])}],['zach',{keys:new Set(['s5']),booked:new Set()}]])})}});
  vm.runInContext(fn('pickOwnHelperPrimary'),f.ctx);
  assert.equal(await f.ctx.pickOwnHelperPrimary(f.db,[],'2026-09-15','s5','America/Denver'),'zach');
  const a=source.indexOf("    if (secondaryRaw === 'any') {",source.indexOf('async function bookingCreate('));
  const b=source.indexOf('    } else {\n      // excludeTechId=',a);assert.ok(a>0&&b>a);
  Object.assign(f.ctx,{db:f.db,scopes:[],biz:{},effectivePostalCode:'80202',tz:'America/Denver',secondaryRaw:'any',
    body:{needs_lifting:true,scheduled_date:'2026-09-15',scheduled_slot:'s5'},pickAvailableTechPair:async()=>({primaryId:null,secondaryId:null}),
    pickAvailableTech:()=>{throw Error('must not pick a different single tech before the own-helper candidate');}});
  vm.runInContext('async function autoPick(){let technician_id=null;\n'+source.slice(a,b)+'\n}return technician_id;}',f.ctx);
  assert.equal(await f.ctx.autoPick(),'zach');
});
