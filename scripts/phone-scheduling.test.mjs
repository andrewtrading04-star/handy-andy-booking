import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
function cut(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing source: ${start}`);return html.slice(a,b);}
const helpers=cut('function cwAfterHoursFeeFor(', '// The Frame/Gallery stepper');
const branch=cut("  if(s==='schedule'){","  if(s==='recap'){");
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function setup({mandatory=false,service='TV Mounting',zip='80202',area='Denver',now='2026-09-16T12:00:00Z'}={}){
  const nodes=new Map(),requests=[],renders=[],tracks=[];
  class Element{
    constructor(id='',tag='div'){Object.assign(this,{id,tag,value:'',textContent:'',disabled:false,style:{},dataset:{},handlers:{},children:[],classes:new Set()});this.classList={add:k=>this.classes.add(k),remove:k=>this.classes.delete(k),contains:k=>this.classes.has(k)};}
    addEventListener(event,fn){this.handlers[event]=fn;}
    fire(event='click'){if(this.disabled)return Promise.resolve();return Promise.resolve(this.handlers[event]?.({target:this}));}
    get innerHTML(){return this.markup||'';}
    set innerHTML(value){
      for(const child of this.children)if(child.id && nodes.get(child.id)===child)nodes.delete(child.id);
      this.markup=value;this.children=[];
      for(const m of value.matchAll(/<([a-z]+)\b[^>]*>/g)){
        const id=m[0].match(/\bid="([^"]+)"/)?.[1]||'', child=new Element(id,m[1]);
        child.disabled=/\sdisabled(?:[\s=>]|$)/.test(m[0]);
        child.classes=new Set((m[0].match(/\bclass="([^"]+)"/)?.[1]||'').split(/\s+/));
        const style=m[0].match(/\bstyle="([^"]*)"/)?.[1]||'';const display=style.match(/(?:^|;)display:([^;]*)/);if(display)child.style.display=display[1];
        for(const a of m[0].matchAll(/data-([\w]+)="([^"]+)"/g))child.dataset[a[1]]=a[2];
        this.children.push(child);if(id)nodes.set(id,child);
      }
    }
    querySelectorAll(selector){return this.children.filter(c=>selector.startsWith('.') && selector.slice(1).split('.').every(k=>c.classes.has(k)));}
  }
  const node=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  const draft={id:'call-1',business:'doms',service,zip,areaName:area,step:'schedule',_view:0,_visible:true,resolution:null,calMonth:null,prefDate:'',selectedSlot:null,availDates:null};
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();}}
  const ctx=vm.createContext({Date:FixedDate,Intl,Set,Promise,console,callWiz:draft,current:{slug:'doms',timezone:'America/Denver'},
    document:{getElementById:node},esc:String,cwBusiness:()=>({slug:'doms',timezone:'America/Denver'}),nbSecondTechMode:()=>mandatory?'mandatory':'none',nbSelectedLiftingKind:()=>null,
    cwIsActive:(d,view)=>ctx.callWiz===d&&d._visible&&d._view===view,
    cwInvalidatePrice:d=>{d.priceInvalidations=(d.priceInvalidations||0)+1;},callWizScript:s=>s,cwBackBtnHtml:()=>'',cwWireBack:fn=>{ctx.back=fn;},cwBackFromSchedule:()=>{draft.step='tvopts';},
    cwTrack:(...args)=>tracks.push(args),cwSlotStart:s=>s.split('–')[0].trim(),cwSpokenAmount:String,
    renderCallWiz:()=>renders.push(ctx.callWiz.step),
    api:(action,options)=>new Promise((resolve,reject)=>requests.push({action,options,resolve,reject})),
  });
  vm.runInContext(helpers+`\nasync function mount(){const draft=callWiz,view=++draft._view,isHere=()=>cwIsActive(draft,view),s='schedule',body=document.getElementById('body'),err=document.getElementById('err');${branch}}`,ctx);
  return {ctx,draft,node,nodes,requests,renders,tracks,mount:()=>ctx.mount(),
    dates:()=>requests.filter(r=>r.action==='available_dates'),slots:()=>requests.filter(r=>r.action==='available_slots'),
    async calendar(dates=['2026-09-17','2026-09-18']){this.dates().at(-1).resolve({dates});await flush();},
    date(date){return node('cwCalGrid').querySelectorAll('.nb-cal-day.avail').find(c=>c.dataset.date===date);},
    slot(key){return node('cwSlots').querySelectorAll('.nb-slot').find(c=>c.dataset.key===key);},
    async choose(date='2026-09-17',key='s2'){const pending=this.date(date).fire();this.slots().at(-1).resolve({slots:[{slot_key:key,label:key==='s5'?'8:00 PM – 10:30 PM':'11:00 AM – 1:00 PM'}]});await pending;await this.slot(key).fire();},
  };
}

test('large TV date and time queries require the same two-person pool as booking',async()=>{
  const f=setup({mandatory:true});await f.mount();await f.calendar();const pending=f.date('2026-09-17').fire();
  for(const r of [f.dates()[0],f.slots()[0]]){assert.equal(r.options.params.secondary_technician_id,'any');assert.equal(r.options.params.pool2,'own');assert.equal(r.options.params.needs_lifting,'1');assert.equal(r.options.params.business,'doms');assert.equal(r.options.params.postal_code,'80202');}
  f.slots()[0].resolve({slots:[]});await pending;
});
test('regular TV and handyman queries retain one-technician availability',async()=>{
  for(const options of [{mandatory:false},{mandatory:true,service:'Handyman'}]){
    const f=setup(options);await f.mount();assert.equal(f.dates()[0].options.params.secondary_technician_id,undefined);assert.equal(f.dates()[0].options.params.needs_lifting,undefined);
    f.dates()[0].resolve({dates:[]});await flush();
  }
});
test('the actual 75-inch paid helper and 86-inch required helper answers request two people',async()=>{
  for(const [size,label,pair] of [[85,'2 technicians',true],[85,'70–85" — customer cannot help lift',true],[97,'85"+ (second technician required)',true],[85,'70–85" — customer can help lift',false]]){
    const f=setup();
    f.ctx.nbOptionGroups=[{id:'lifting',key:'lifting',options:[{id:'selected-lift',label}]}];
    f.ctx.nbPickGet=()=> 'selected-lift';f.ctx.nbSelectedSizeMaxList=()=>[size];
    vm.runInContext(cut('function nbLiftingKind(', '// The chosen second tech as'),f.ctx);
    await f.mount();await f.calendar();const pending=f.date('2026-09-17').fire();
    for(const r of [f.dates()[0],f.slots()[0]]){assert.equal(!!r.options.params.secondary_technician_id,pair,label);assert.equal(r.options.params.needs_lifting,pair?'1':undefined,label);}
    f.slots()[0].resolve({slots:[{slot_key:'s2',label:'11 AM'}]});await pending;await f.slot('s2').fire();
    assert.equal(!!f.ctx.cwScheduleParams(f.draft).secondary_technician_id,pair,'booking uses the same schedule parameters');
  }
});
test('the calendar starts in the customer month while UTC and the secretary are on tomorrow',async()=>{
  const f=setup({now:'2026-10-01T01:00:00Z'});await f.mount();assert.equal(f.dates()[0].options.params.month,'2026-09');
  assert.equal(f.ctx.cwScheduleToday(f.draft,new Date('2026-10-01T01:00:00Z')),'2026-09-30');
  assert.match(f.node('cwTimeZone').innerHTML||f.node('body').innerHTML,/Mountain time/);
});
test('resumed slot stays blocked until refreshed and disappears if no longer available',async()=>{
  const f=setup();await f.mount();await f.calendar();await f.choose();assert.equal(f.ctx.cwSlotIsVerified(f.draft),true);
  await f.mount();assert.equal(f.draft.selectedSlot,null);assert.equal(f.node('cwSchedNext').style.display,'none');
  await f.node('cwSchedNext').fire();assert.equal(f.draft.step,'schedule');assert.match(f.node('err').textContent,/available date/);
  f.slots().at(-1).resolve({slots:[]});await flush();assert.equal(f.ctx.cwSlotIsVerified(f.draft),false);assert.equal(f.draft.selectedSlot,null);
});
test('resuming preserves an available selection only after it is rechecked',async()=>{
  const f=setup();await f.mount();await f.calendar();await f.choose();await f.mount();
  f.slots().at(-1).resolve({slots:[{slot_key:'s2',label:'Fresh server label'}]});await flush();
  assert.equal(f.draft.selectedSlot.label,'Fresh server label');assert.equal(f.ctx.cwSlotIsVerified(f.draft),true);assert.equal(f.node('cwSchedNext').style.display,'');
});
test('changing dates clears old time buttons immediately and stale handlers cannot select them',async()=>{
  const f=setup();await f.mount();await f.calendar();await f.choose();const old=f.slot('s2');
  const pending=f.date('2026-09-18').fire();assert.match(f.node('cwSlots').innerHTML,/Checking available times/);assert.equal(f.draft.selectedSlot,null);
  await old.fire();assert.equal(f.draft.selectedSlot,null);assert.equal(f.node('cwSchedNext').style.display,'none');
  f.slots().at(-1).resolve({slots:[{slot_key:'s3',label:'2 PM'}]});await pending;await f.slot('s3').fire();assert.equal(f.draft.prefDate,'2026-09-18');assert.equal(f.ctx.cwSlotIsVerified(f.draft),true);
});
test('out-of-order time responses keep the latest date times',async()=>{
  const f=setup();await f.mount();await f.calendar();const first=f.date('2026-09-17').fire(),second=f.date('2026-09-18').fire();
  f.slots()[1].resolve({slots:[{slot_key:'s3',label:'Latest date'}]});await second;f.slots()[0].resolve({slots:[{slot_key:'s1',label:'Old date'}]});await first;
  assert.match(f.node('cwSlots').innerHTML,/Latest date/);assert.doesNotMatch(f.node('cwSlots').innerHTML,/Old date/);
});
test('slot failure clears verification and Retry times loads a fresh result',async()=>{
  const f=setup();await f.mount();await f.calendar();const pending=f.date('2026-09-17').fire();f.slots()[0].reject(Error('Network unavailable'));await pending;
  assert.match(f.node('cwSlots').innerHTML,/Retry times/);assert.equal(f.ctx.cwSlotIsVerified(f.draft),false);
  const retry=f.node('cwSlotsRetry').fire();f.slots()[1].resolve({slots:[{slot_key:'s2',label:'11 AM'}]});await retry;await f.slot('s2').fire();assert.equal(f.ctx.cwSlotIsVerified(f.draft),true);
});
test('calendar failure has a working Retry calendar button',async()=>{
  const f=setup();await f.mount();f.dates()[0].reject(Error('Network unavailable'));await flush();assert.match(f.node('cwCalNote').innerHTML,/Retry calendar/);
  const retry=f.node('cwCalRetry').fire();f.dates()[1].resolve({dates:['2026-09-17']});await retry;assert.ok(f.date('2026-09-17'));assert.equal(f.node('cwCalNote').style.display,'none');
});
test('incomplete date or slot payloads cannot masquerade as an available selection',async()=>{
  const f=setup();await f.mount();f.dates()[0].resolve({});await flush();assert.match(f.node('cwCalNote').innerHTML,/incomplete response/);
  const retry=f.node('cwCalRetry').fire();f.dates()[1].resolve({dates:['2026-09-17']});await retry;
  const pending=f.date('2026-09-17').fire();f.slots()[0].resolve({slots:[{}]});await pending;assert.match(f.node('cwSlots').innerHTML,/incomplete response/);assert.equal(f.ctx.cwSlotIsVerified(f.draft),false);
});
test('changing month clears the old agreement and ignores detached day controls',async()=>{
  const f=setup();await f.mount();await f.calendar();await f.choose();const day=f.date('2026-09-18');
  await f.node('cwCalNext').fire();assert.equal(f.draft.prefDate,'');assert.equal(f.draft.selectedSlot,null);assert.equal(f.node('cwSlotsWrap').style.display,'none');
  const calls=f.slots().length;await day.fire();assert.equal(f.slots().length,calls);assert.equal(f.dates().at(-1).options.params.month,'2026-10');
});
test('unknown and unstaffed ZIPs explain the empty calendar without offering dates',async()=>{
  for(const [reason,copy] of [['zip_not_covered',/don't cover/],['area_unstaffed',/No technician/],['no_techs_in_area',/No technician/]]){
    const f=setup();await f.mount();f.dates()[0].resolve({dates:[],reason});await flush();assert.match(f.node('cwCalNote').innerHTML,copy);assert.equal(f.node('cwCalGrid').querySelectorAll('.nb-cal-day.avail').length,0);
    await f.node('cwSchedSkip').fire();assert.equal(f.draft.step,'recap');assert.equal(f.draft.selectedSlot,null);
  }
});
test('customer not ready removes the earlier date, slot and after-hours agreement',async()=>{
  const f=setup();await f.mount();await f.calendar();await f.choose('2026-09-17','s5');await f.node('cwSchedSkip').fire();
  assert.equal(f.draft.step,'recap');assert.equal(f.draft.prefDate,'');assert.equal(f.draft.selectedSlot,null);assert.equal(f.ctx.cwSlotIsVerified(f.draft),false);
});
test('late responses and detached handlers cannot navigate another call or card',async()=>{
  const f=setup();await f.mount();await f.calendar();const next=f.node('cwSchedNext'),pending=f.date('2026-09-17').fire();
  f.draft.step='resolution';f.draft._view++;f.slots()[0].resolve({slots:[{slot_key:'s2',label:'Old response'}]});await pending;await next.fire();
  assert.equal(f.draft.step,'resolution');assert.equal(f.draft.selectedSlot,null);assert.equal(f.renders.length,0);
});
test('Sunday and weekday after-hours fees stay tied to the job date and service',()=>{
  const f=setup();assert.equal(f.ctx.cwAfterHoursFeeFor('s5','2026-09-20'),100);assert.equal(f.ctx.cwAfterHoursFeeFor('s5','2026-09-21'),75);assert.equal(f.ctx.cwAfterHoursFeeFor('s2','2026-09-20'),0);
  assert.equal(f.ctx.cwAfterHoursFeeFor('s5','2026-09-20',{service:'Handyman'}),0);
});
test('changing the ZIP or two-person requirement invalidates the previous slot on return',async()=>{
  for(const changed of ['zip','pair']){
    const f=setup();await f.mount();await f.calendar();await f.choose();
    if(changed==='zip')f.draft.zip='78701';else f.ctx.nbSecondTechMode=()=> 'mandatory';
    assert.equal(f.ctx.cwSlotIsVerified(f.draft),false);await f.mount();assert.equal(f.draft.prefDate,'');assert.equal(f.draft.selectedSlot,null);
  }
});
test('authoritative response timezone replaces the area fallback only for its ZIP',async()=>{
  const f=setup({zip:'99999',area:null});await f.mount();f.dates()[0].resolve({dates:[],timezone:'America/Los_Angeles'});await flush();
  assert.equal(f.ctx.cwScheduleTimezone(f.draft),'America/Los_Angeles');assert.match(f.node('cwTimeZone').textContent,/Pacific time/);
  f.draft.zip='78701';assert.equal(f.ctx.cwScheduleTimezone(f.draft),'America/Chicago');
});
