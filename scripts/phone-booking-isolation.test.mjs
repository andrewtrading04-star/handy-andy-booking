import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const extract=(start,end)=>{
  const a=html.indexOf(start), b=html.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a,`Missing source boundary: ${start}`);
  return html.slice(a,b);
};
const sources={
  partner:extract('async function nbLoadPartnerTechs(){','function nbTechOptionsHtml('),
  calendar:extract('async function loadNbCalendar(){','function renderNbCalendar(){'),
  slots:extract('let nbSlotsSeq=0;',"document.getElementById('nbTech').addEventListener('change'"),
  zip:extract("document.getElementById('nbZip').addEventListener('change',async ()=>{","document.getElementById('nbTravelFee').addEventListener"),
  service:extract("document.getElementById('nbService').addEventListener('change',async e=>{",'// ── Payment method + Stripe card entry'),
};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup(source,extra={}){
  const elements=new Map(), counts={populate:0,render:0,total:0,calendar:0};
  function node(id){
    if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',style:{},listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}});
    return elements.get(id);
  }
  node('nbZip').value='80202';node('nbDate').value='2026-09-17';node('nbService').value='service1';
  const ctx=vm.createContext({
    console,Date,Set,Promise,current:{slug:'doms'},nbModalSession:1,nbCalSeq:0,nbCalMonth:new Date('2026-09-01T12:00:00'),
    nbAvailDates:new Set(['existing']),nbSelectedSlot:null,nbPartner:null,nbZipAreaId:null,nbAreaName:'',nbAutoTravel:'',
    nbOptionGroups:[],nbHandymanActive:false,nbAssurionActive:false,nbGdsActive:false,nbNoChargeActive:false,nbServices:[],
    document:{getElementById:node},esc:String,nbInitials:()=>'',nbParseTech:()=>({id:'any',pool:'own'}),
    nbEffectiveSecondTech:()=>null,nbAvailabilityBlockedReason:()=>'',nbMonthKey:()=> '2026-09',
    nbPopulateTechs:()=>counts.populate++,nbPopulateSecondTechs:()=>counts.populate++,
    renderNbCalendar:()=>counts.render++,renderNbSteps:()=>counts.render++,updateNbTotal:()=>counts.total++,
    loadNbCalendar:()=>counts.calendar++,nbLoadPartnerTechs:async()=>{},nbCarriedTravelLine:()=>false,
    nbZipReplyIdle:()=>{},resetNbSteps:()=>{},isHandymanService:()=>false,nbRelocateOneConnect:x=>x,
    ...extra,
  });
  vm.runInContext(source,ctx);
  return {ctx,node,counts,change:id=>node(id).listeners.change({target:node(id)})};
}
const invalidate=(ctx,kind)=>{if(kind==='session')ctx.nbModalSession++;else ctx.current={slug:'austin'};};

for(const kind of ['session','business']){
  test(`late New Booking partner roster cannot overwrite a ${kind} change`,async()=>{
    const d=deferred(), f=setup(sources.partner,{nbPartnerTechLookup:()=>d.promise});
    const run=f.ctx.nbLoadPartnerTechs();invalidate(f.ctx,kind);f.ctx.nbPartner={name:'Current draft'};
    d.resolve({partner:{slug:'old',name:'Old roster'},technicians:[{id:'old-tech'}]});await run;
    assert.equal(f.ctx.nbPartner.name,'Current draft');assert.equal(f.counts.populate,0);
  });
  test(`late New Booking calendar cannot overwrite a ${kind} change`,async()=>{
    const d=deferred(), f=setup(sources.calendar,{api:()=>d.promise});
    const run=f.ctx.loadNbCalendar();invalidate(f.ctx,kind);f.ctx.nbAvailDates=new Set(['phone-date']);
    d.resolve({dates:['old-date']});await run;
    assert.deepEqual([...f.ctx.nbAvailDates],['phone-date']);assert.equal(f.counts.render,0);
  });
  test(`late New Booking slots cannot overwrite a ${kind} change`,async()=>{
    const d=deferred(), f=setup(sources.slots,{api:()=>d.promise});
    const run=f.ctx.loadNbSlots('2026-09-17');invalidate(f.ctx,kind);f.node('nbSlots').innerHTML='Current draft';
    d.resolve({slots:[]});await run;
    assert.equal(f.node('nbSlots').innerHTML,'Current draft');assert.equal(f.counts.total,0);
  });
  test(`late New Booking ZIP cannot change phone prices after a ${kind} change`,async()=>{
    const d=deferred(), f=setup(sources.zip,{nbZipAreaLookup:()=>d.promise});
    const run=f.change('nbZip');invalidate(f.ctx,kind);f.ctx.nbAreaName='Austin';f.ctx.nbZipAreaId='phone-area';f.node('nbTravelFee').value='25';
    d.resolve({name:'Denver',service_area_id:'old-area',surcharge:65});await run;
    assert.equal(f.ctx.nbAreaName,'Austin');assert.equal(f.ctx.nbZipAreaId,'phone-area');assert.equal(f.node('nbTravelFee').value,'25');
    assert.equal(f.counts.render+f.counts.total+f.counts.calendar,0);
  });
  test(`late New Booking service options cannot replace phone answers after a ${kind} change`,async()=>{
    const d=deferred(), f=setup(sources.service,{api:()=>d.promise});
    const run=f.change('nbService');invalidate(f.ctx,kind);f.ctx.nbOptionGroups=[{id:'phone-options'}];
    d.resolve({groups:[{id:'old-options'}]});await run;
    assert.equal(f.ctx.nbOptionGroups[0].id,'phone-options');assert.equal(f.counts.render,0);
  });
}

test('late failures leave the resumed draft and error UI intact',async()=>{
  for(const name of ['partner','calendar','slots','zip','service']){
    const d=deferred(), f=setup(sources[name],{api:()=>d.promise,nbPartnerTechLookup:()=>d.promise,nbZipAreaLookup:()=>d.promise});
    const run=name==='partner'?f.ctx.nbLoadPartnerTechs():name==='calendar'?f.ctx.loadNbCalendar():name==='slots'?f.ctx.loadNbSlots('2026-09-17'):f.change(name==='zip'?'nbZip':'nbService');
    f.ctx.nbModalSession++;f.ctx.nbAvailDates=new Set(['phone-date']);f.ctx.nbAreaName='Austin';f.node('nbErr').textContent='Current error';
    d.reject(new Error('Old request failed'));await run;
    assert.equal(f.node('nbErr').textContent,'Current error',name);assert.deepEqual([...f.ctx.nbAvailDates],['phone-date'],name);
    assert.equal(f.ctx.nbAreaName,'Austin',name);assert.equal(Object.values(f.counts).reduce((a,b)=>a+b,0),0,name);
  }
});

test('ZIP continuation waiting on partner roster cannot clear the resumed phone draft',async()=>{
  const d=deferred(), f=setup(sources.zip,{nbZipAreaLookup:async()=>({name:'Denver',service_area_id:'denver',surcharge:15}),nbLoadPartnerTechs:()=>d.promise});
  const run=f.change('nbZip');await Promise.resolve();await Promise.resolve();await Promise.resolve();
  f.ctx.nbModalSession++;f.ctx.nbSelectedSlot={key:'phone-slot'};f.node('nbDate').value='2026-09-20';
  d.resolve();await run;
  assert.equal(f.ctx.nbSelectedSlot.key,'phone-slot');assert.equal(f.node('nbDate').value,'2026-09-20');assert.equal(f.counts.calendar,0);
});

test('earlier ZIP response cannot overwrite a corrected ZIP within one draft',async()=>{
  const old=deferred(), fresh=deferred(), f=setup(sources.zip,{nbZipAreaLookup:(_slug,postal)=>postal==='80202'?old.promise:fresh.promise});
  const first=f.change('nbZip');f.node('nbZip').value='78701';const second=f.change('nbZip');
  fresh.resolve({name:'Austin',service_area_id:'austin',surcharge:25});await second;
  old.resolve({name:'Denver',service_area_id:'denver',surcharge:65});await first;
  assert.equal(f.ctx.nbAreaName,'Austin');assert.equal(f.node('nbTravelFee').value,'25');assert.equal(f.counts.calendar,1);
});

test('earlier slots response cannot replace a more recently requested date',async()=>{
  const old=deferred(), fresh=deferred(), f=setup(sources.slots,{api:(_action,{params})=>params.date==='2026-09-17'?old.promise:fresh.promise});
  const first=f.ctx.loadNbSlots('2026-09-17');f.node('nbDate').value='2026-09-18';const second=f.ctx.loadNbSlots('2026-09-18');
  fresh.resolve({slots:[{slot_key:'new-slot',label:'New time'}]});await second;
  old.resolve({slots:[]});await first;
  assert.match(f.node('nbSlots').innerHTML,/New time/);assert.equal(f.counts.total,1);
});

test('current New Booking responses still populate the form',async()=>{
  const partner=setup(sources.partner,{nbPartnerTechLookup:async()=>({partner:{slug:'partner',name:'Partner'},technicians:[{id:'tech'}]})});
  await partner.ctx.nbLoadPartnerTechs();assert.equal(partner.ctx.nbPartner.name,'Partner');assert.equal(partner.counts.populate,2);
  const calendar=setup(sources.calendar,{api:async()=>({dates:['2026-09-18']})});
  await calendar.ctx.loadNbCalendar();assert.deepEqual([...calendar.ctx.nbAvailDates],['2026-09-18']);assert.equal(calendar.counts.render,1);
  const service=setup(sources.service,{api:async()=>({groups:[{id:'current-options'}]})});
  await service.change('nbService');assert.equal(service.ctx.nbOptionGroups[0].id,'current-options');assert.equal(service.counts.render,1);
});
