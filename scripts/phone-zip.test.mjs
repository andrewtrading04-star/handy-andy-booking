import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const start=html.indexOf("  if(s==='zip'){",html.indexOf('async function renderCallWiz(){'));
const branch=html.slice(start,html.indexOf('  // TV Mounting questions',start));
const helper=html.slice(html.indexOf('function cwLookupZip('),html.indexOf('function cwHoldActions('));
const active=html.slice(html.indexOf('function cwIsActive('),html.indexOf('function cwBusiness('));
const invalidate=html.slice(html.indexOf('function cwInvalidatePrice('),html.indexOf('// The pricing engine is shared'));
const area=(name='Denver',surcharge=65)=>({name,surcharge,service_area_id:name+'-id',other_business:null});
function setup(){
 const nodes=new Map(), requests=[], renders=[], updates=[];
 const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',disabled:false,events:{},
  addEventListener(name,fn){this.events[name]=fn;},focus(){},fire(name){return this.events[name]?.();}});return nodes.get(id);};
 const draft={id:'a',business:'doms',_visible:true,_view:0,_quoteVersion:0,_econRequest:0,_couponRequest:0,resolution:null,zip:'',zipLookup:null,step:'zip',service:'TV Mounting',areaName:null,surcharge:0};
 const ctx=vm.createContext({Promise,console,callWiz:draft,current:{slug:'doms'},nbAreaName:'',nbZipAreaId:null,
  document:{getElementById:el},esc:s=>String(s||''),callWizScript:s=>s,cwBackBtnHtml:()=>'',cwWireBack:()=>{},
  api:(action,options)=>new Promise((resolve,reject)=>requests.push({action,options,resolve,reject})),
  cwCallUpdate:patch=>{updates.push(patch);return Promise.resolve();},cwTrack:()=>{},renderCallWiz:()=>renders.push(ctx.callWiz.step)});
 vm.runInContext(active+invalidate+helper+`async function mount(){const draft=callWiz,view=++draft._view,isHere=()=>cwIsActive(draft,view),s='zip',bizName="Dom's",body=document.getElementById('body');${branch}}`,ctx);
 return {ctx,draft,el,requests,renders,updates,mount:()=>ctx.mount()};
}
test('typing, blur and Continue share one ZIP request',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';
 const changes=[t.el('cwZip').fire('change'),t.el('cwZip').fire('blur'),t.el('cwZipNext').fire('click')];
 assert.equal(t.requests.length,1);assert.equal(t.requests[0].options.params.business,'doms');
 t.requests[0].resolve(area());await Promise.all(changes);
 assert.equal(t.draft.step,'tvopts');assert.equal(t.draft.surcharge,65);assert.equal(t.draft.zip,'80202');
});
test('a failed first Continue stays on ZIP and a successful retry advances',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';
 const first=t.el('cwZipNext').fire('click');t.requests[0].reject(Error('offline'));await first;
 assert.equal(t.draft.step,'zip');assert.equal(t.updates.length,0);assert.match(t.el('cwZipResult').textContent,/Try again/);assert.equal(t.el('cwZipNext').disabled,false);
 const retry=t.el('cwZipNext').fire('click');assert.equal(t.requests.length,2);t.requests[1].resolve(area());await retry;
 assert.equal(t.draft.step,'tvopts');assert.equal(t.draft.surcharge,65);
});
test('Hang up during ZIP lookup cannot be replaced by the late continuation',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';const next=t.el('cwZipNext').fire('click');
 t.draft.step='resolution';t.draft._view++;t.requests[0].resolve(area());await next;
 assert.equal(t.draft.step,'resolution');assert.equal(t.draft.surcharge,0);assert.equal(t.updates.length,0);
});
test('an old ZIP response cannot write a new conversation or shared fee',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';const pending=t.el('cwZip').fire('blur');
 t.ctx.callWiz={id:'b',business:'austin',_visible:true,_view:0,resolution:null,step:'greet',surcharge:25};t.ctx.current={slug:'austin'};t.el('nbTravelFee').value='25';
 t.requests[0].resolve(area());await pending;
 assert.equal(t.ctx.callWiz.surcharge,25);assert.equal(t.ctx.callWiz.areaName,undefined);assert.equal(t.el('nbTravelFee').value,'25');
});
test('editing ZIP saves the draft immediately and clears the previous price',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';const first=t.el('cwZip').fire('blur');t.requests[0].resolve(area());await first;
 t.el('cwZip').value='78701';t.el('cwZip').fire('input');
 assert.equal(t.draft.zip,'78701');assert.equal(t.draft.surcharge,0);assert.equal(t.ctx.nbAreaName,'');assert.equal(t.el('nbTravelFee').value,'');
});
test('returning to ZIP A while ZIP B loads cannot display B fees under A',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';let p=t.el('cwZip').fire('blur');t.requests[0].resolve(area());await p;
 t.el('cwZip').value='78701';t.el('cwZip').fire('input');p=t.el('cwZip').fire('blur');
 t.el('cwZip').value='80202';t.el('cwZip').fire('input');t.requests[1].resolve(area('Austin',0));await p;
 assert.equal(t.ctx.nbAreaName,'');assert.equal(t.draft.areaName,null);
 const retry=t.el('cwZipNext').fire('click');assert.equal(t.requests.length,3);t.requests[2].resolve(area());await retry;
 assert.equal(t.ctx.nbAreaName,'Denver');assert.equal(t.draft.zip,'80202');assert.equal(t.draft.surcharge,65);
});
test('later ZIP responses win regardless of network completion order',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';const first=t.el('cwZip').fire('blur');
 t.el('cwZip').value='78701';t.el('cwZip').fire('input');const second=t.el('cwZip').fire('blur');
 t.requests[1].resolve(area('Austin',0));await second;t.requests[0].resolve(area());await first;
 assert.equal(t.ctx.nbAreaName,'Austin');assert.equal(t.draft.surcharge,0);
});
test('a completed lookup is reused and invalid ZIP input makes no request',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='1234';await t.el('cwZipNext').fire('click');assert.equal(t.requests.length,0);
 t.el('cwZip').value='80202';const p=t.el('cwZip').fire('blur');t.requests[0].resolve(area());await p;
 await t.el('cwZipNext').fire('click');assert.equal(t.requests.length,1);assert.equal(t.draft.step,'tvopts');
});
test('malformed lookup response cannot confirm a free fee',async()=>{
 const t=setup();await t.mount();t.el('cwZip').value='80202';const p=t.el('cwZipNext').fire('click');t.requests[0].resolve({name:'Denver'});await p;
 assert.equal(t.draft.step,'zip');assert.match(t.el('cwZipResult').textContent,/Try again/);
});
test('ZIP request parameters stay bound to the caller business',async()=>{
 const t=setup();t.ctx.current={slug:'austin'};await t.mount();t.el('cwZip').value='80202';const p=t.el('cwZipNext').fire('click');
 assert.equal(t.requests[0].options.params.business,'doms');assert.equal(t.requests[0].options.timeoutMs,12000);t.requests[0].resolve(area());await p;
});
