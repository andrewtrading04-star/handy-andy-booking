import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {SLOTS, dayOfWeekFor} from '../api/_lib/availability.js';
import {localDateStartUTC, addDaysStr} from '../api/_lib/time.js';

const source=fs.readFileSync(new URL('../api/admin.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8').replaceAll('\r\n','\n');
function fn(name,text=source){const a=text.search(new RegExp('^(?:async )?function '+name+'\\(','m')),b=text.indexOf('\n}\n',a);assert.ok(a>=0&&b>a,name);return text.slice(a,b+3);}
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=x=>JSON.parse(JSON.stringify(x));
function dbFor(run){const queries=[];return {queries,from(table){const q={table,filters:[]};queries.push(q);const b={};
  for(const key of ['select','eq','neq','not','gte','lt','in','or','order'])b[key]=(...args)=>{q.filters.push([key,...args]);return b;};
  b.single=()=>Promise.resolve().then(()=>run(q));b.then=(a,z)=>Promise.resolve().then(()=>run(q)).then(a,z);return b;}};}
const scope=[{bizId:'home',serviceAreaId:'denver'}],date='2026-10-05',tz='America/Denver';
function staffing({techs=[{id:'a',name:'Steve'},{id:'b',name:'TK'},{id:'c',name:'Other'}],rows,exceptions=[],bookings=[],failTable=null}={}){
  const db=dbFor(q=>{
    if(q.table===failTable)return {error:Error('Unavailable '+q.table)};
    const key=k=>q.filters.find(([op,col])=>op==='eq'&&col===k)?.[2];
    if(q.table==='technicians')return {data:techs.filter(t=>(!t.biz||t.biz===key('business_id'))&&(!t.area||t.area===key('service_area_id')))};
    if(q.table==='technician_availability')return {data:rows||techs.map(t=>({technician_id:t.id,slot_key:'s1'}))};
    if(q.table==='technician_availability_exceptions')return {data:exceptions};
    if(q.table==='bookings')return {data:bookings};
    throw Error(q.table);
  });
  const ctx=vm.createContext({Date,Intl,Map,Set,Promise,SLOTS,dayOfWeekFor,localDateStartUTC,addDaysStr,
    bookingLiftCols:true,extraSlotsCol:true,esCol:()=>', extra_slots',esOf:b=>b.extra_slots||[],
    isSecondaryIneligibleName:name=>/^(Juan|Zach)$/.test(name),applySoleTech:(_slug,techs)=>techs.filter(t=>t.name==='Zach')});
  vm.runInContext(['missingColumn','localHHMM','slotKeyForLocalTime','normalizeRosterScopes','scopedRosterTechs','batchTechSlotState','pickAvailableTech','pickAvailableTechPair'].map(n=>fn(n)).join('\n'),ctx);
  return {ctx,db,pick:(...args)=>ctx.pickAvailableTech(db,scope,date,'s1',tz,...args),pair:(p=scope,s=scope)=>ctx.pickAvailableTechPair(db,p,s,date,'s1',tz)};
}
test('auto-assignment checks a busy roster in three schedule reads regardless of roster length',async()=>{
  const techs=Array.from({length:20},(_,i)=>({id:'t'+i,name:'Tech '+i}));
  const bookings=techs.slice(0,-1).map(t=>({technician_id:t.id,scheduled_at:'2026-10-05T14:00:00Z'}));
  const f=staffing({techs,bookings});assert.equal(await f.pick(null,false,true),'t19');
  assert.equal(f.db.queries.length,4);assert.equal(f.db.queries.filter(q=>q.table==='bookings').length,1);
});
test('exceptions, helper occupancy and extra slots all exclude auto-assignment candidates',async()=>{
  const f=staffing({techs:['a','b','c','d'].map(id=>({id,name:id})),
    exceptions:[{technician_id:'a',slot_key:'s1',is_available:false}],
    bookings:[{technician_id:'unrelated',secondary_technician_id:'b',scheduled_at:'2026-10-05T14:00:00Z'},
      {technician_id:'c',scheduled_at:'2026-10-05T17:00:00Z',extra_slots:['s1']}]});
  assert.equal(await f.pick(null,false,true),'d');
});
test('secondary exclusions and strict scheduling survive batched selection',async()=>{
  const f=staffing({techs:[{id:'juan',name:'Juan'},{id:'zach',name:'Zach'},{id:'primary',name:'Steve'},{id:'helper',name:'TK'}]});
  assert.equal(await f.pick('primary',true,true),'helper');
  const off=staffing({rows:[]});assert.equal(await off.pick(null,false,true),null);assert.equal(await off.pick(), 'a');
});
test('one-time available exceptions can staff someone without recurring hours',async()=>{
  const f=staffing({rows:[],exceptions:[{technician_id:'b',slot_key:'s1',is_available:true}]});
  assert.equal(await f.pick(null,false,true),'b');
});
test('same-pool pair uses one roster read and one shared schedule batch',async()=>{
  const f=staffing();assert.deepEqual(plain(await f.pair()),{primaryId:'a',secondaryId:'b'});
  assert.equal(f.db.queries.length,4);
  const ids=f.db.queries.find(q=>q.table==='technician_availability').filters.find(([k])=>k==='in')[2];
  assert.deepEqual(plain(ids),['a','b','c']);
});
test('pair matching preserves the only helper instead of greedily consuming them as primary',async()=>{
  const f=staffing({techs:[{id:'tk',name:'TK',biz:'helper'},{id:'steve',name:'Steve',biz:'home'}]});
  const helpers=[{bizId:'helper',serviceAreaId:'denver'}];
  assert.deepEqual(plain(await f.pair([...helpers,...scope],helpers)),{primaryId:'steve',secondaryId:'tk'});
});
test('pair matching rejects a single person and never uses Juan or Zach as a helper',async()=>{
  for(const techs of [[{id:'a',name:'Steve'}],[{id:'a',name:'Juan'},{id:'b',name:'Zach'}]]){
    assert.deepEqual(plain(await staffing({techs}).pair()),{primaryId:null,secondaryId:null});
  }
});
test('an unavailable database fails closed during both assignment paths',async()=>{
  for(const table of ['technicians','technician_availability','technician_availability_exceptions','bookings']){
    const f=staffing({failTable:table});await assert.rejects(f.pick(null,false,true),/Unavailable/);await assert.rejects(f.pair(),/Unavailable/);
  }
});
test('unknown metro has no candidates and sole-technician brand locks remain enforced',async()=>{
  const f=staffing({techs:[{id:'a',name:'Steve'},{id:'z',name:'Zach'}]});
  assert.deepEqual(plain(await f.ctx.scopedRosterTechs(f.db,[{bizId:'home',serviceAreaId:null}])),[]);
  assert.equal(f.db.queries.length,0);
  assert.deepEqual(plain(await f.ctx.scopedRosterTechs(f.db,[{...scope[0],soleTechOf:'austin'}])),[[{id:'z',name:'Zach'}]]);
});
test('rosters load concurrently without changing host-first priority when the partner replies first',async()=>{
  const home=deferred(),partner=deferred(),db=dbFor(q=>q.filters.find(([op,k])=>op==='eq'&&k==='business_id')[2]==='home'?home.promise:partner.promise);
  const f=staffing(),p=f.ctx.scopedRosterTechs(db,[...scope,{bizId:'partner',serviceAreaId:'denver'}]);
  await tick();assert.equal(db.queries.length,2);partner.resolve({data:[{id:'partner'}]});home.resolve({data:[{id:'home'}]});
  assert.deepEqual(plain(await p),[[{id:'home'}],[{id:'partner'}]]);
  assert(db.queries.every(q=>q.filters.some(([op,k,v])=>op==='eq'&&k==='active'&&v===true)));
});
function business(run){const ctx=vm.createContext({Map,Promise,Date,mayUseBusiness:(auth,slug)=>auth.scope==='all'||auth.scope===slug});
  vm.runInContext('const _bizCache=new Map(),_bizPending=new Map(),BIZ_CACHE_TTL_MS=60000;\n'+fn('resolveBusiness'),ctx);
  const db=dbFor(run);return {ctx,db,resolve:(scope,slug='doms')=>ctx.resolveBusiness(db,{scope},slug)};
}
test('simultaneous phone requests share business reads without bypassing authorization',async()=>{
  const gate=deferred(),f=business(()=>gate.promise),a=f.resolve('doms'),b=f.resolve('doms');
  await assert.rejects(f.resolve('other'),e=>e.status===403);assert.equal(f.db.queries.length,1);
  gate.resolve({data:{id:'biz',slug:'doms'}});assert.equal((await a).id,'biz');assert.equal((await b).id,'biz');
  await assert.rejects(f.resolve('other'),e=>e.status===403);await f.resolve('all');assert.equal(f.db.queries.length,1);
});
test('failed shared business lookup is evicted and can be retried',async()=>{
  let tries=0;const f=business(()=>++tries===1?{error:Error('offline')}:{data:{id:'biz'}});
  const rejected=await Promise.allSettled([f.resolve('doms'),f.resolve('doms')]);assert(rejected.every(r=>r.status==='rejected'));
  assert.equal((await f.resolve('doms')).id,'biz');assert.equal(tries,2);
});
function timers(){const pending=new Set();return {pending,setTimeout(fn){const t={fn};pending.add(t);return t;},clearTimeout:t=>pending.delete(t),expire(){for(const t of [...pending]){pending.delete(t);t.fn();}}};}
test('completed and failed timed operations release their timers; hung operations still time out',async()=>{
  const t=timers(),ctx=vm.createContext({...t});vm.runInContext(fn('nbWithTimeout',html),ctx);
  assert.equal(await ctx.nbWithTimeout(Promise.resolve(42),100,'slow'),42);assert.equal(t.pending.size,0);
  await assert.rejects(ctx.nbWithTimeout(Promise.reject(Error('offline')),100,'slow'),/offline/);assert.equal(t.pending.size,0);
  const p=ctx.nbWithTimeout(new Promise(()=>{}),100,'slow'),caught=assert.rejects(p,/slow/);t.expire();await caught;assert.equal(t.pending.size,0);
});
test('card prefetch is shared, creates no card/account, and a failed download can retry',async()=>{
  const t=timers(),scripts=[],ctx=vm.createContext({...t,window:{},document:{createElement:()=>({remove(){this.removed=true;}}),head:{appendChild:s=>scripts.push(s)}}});
  vm.runInContext('let cwStripeLibraryPromise=null;\n'+fn('nbWithTimeout',html)+'\n'+fn('cwLoadStripeLibrary',html),ctx);
  const a=ctx.cwLoadStripeLibrary(),b=ctx.cwLoadStripeLibrary();assert.equal(a,b);assert.equal(scripts.length,1);
  const caught=assert.rejects(a,/did not answer/);t.expire();await caught;assert.equal(scripts[0].removed,true);assert.equal(scripts[0].onload,null);
  const retry=ctx.cwLoadStripeLibrary();assert.equal(scripts.length,2);ctx.window.Stripe=()=>{throw Error('prefetch must not create an account');};scripts[1].onload();await retry;
  await ctx.cwLoadStripeLibrary();assert.equal(scripts.length,2);assert.equal(t.pending.size,0);
});
