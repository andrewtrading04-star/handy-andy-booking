import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8').replaceAll('\r\n','\n');
function cut(start,end){const a=html.indexOf(start),b=html.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing source boundary: ${start}`);return html.slice(a,b);}
const entry=cut('let callWiz=null;','// A row of tappable choice buttons');
const helpers=cut('function cwBiz(){','function cwLookupZip(');
const requestId=cut('function cwRequestId(){','// Which option groups');
const roundMoney=html.match(/^function cwRoundMoney\(value\).*$/m)[0];
const displayMoney=html.match(/^function cwMoneyCents\(n\).*$/m)[0]+'\n'+html.match(/^function cwMoney\(n\).*$/m)[0];
const pricing=cut('async function cwCouponApplyNow(){','function cwWireCouponApply(){')+
  cut('function cwWireCouponApply(){','function cwWireManualApply(){')+
  cut('function cwCouponDirty(){','// Claim the ladder for THIS call.')+
  html.match(/^function cwOn\(id, ev, fn\).*$/m)[0]+'\n'+
  cut('async function cwLoadEconomics(priced, travelFee, ahFee){','// Hand the whole call — answers, chosen slot, and any discount');
const back=cut('function cwBackBtnHtml(label){','// Step to return to from the schedule card:');
const teardown=cut('function dismissAllOverlays(){','function logout(opts){');
const greet=cut('async function renderCallWiz(){',"  if(s==='zip'){");
const handyman=cut("  if(s==='handydesc'){","  if(s==='schedule'){");
const outcome=cut("  if(s==='resolution'){",'// "Send estimate" now opens');
const reset=html.match(/^function resetNbSteps\(\).*$/m)[0];
// Exercise real greeting/outcome/handyman handlers and draft persistence.
// ZIP, pricing, payment, and other card UI are tested in their own suites.
const renderer=greet+handyman+"if(s!=='resolution'){body.innerHTML='<p>'+s+'</p>';return;}\n"+outcome;
const copy=value=>JSON.parse(JSON.stringify(value));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

function setup(){
  const nodes=new Map(),requests=[],toasts=[],windowHandlers=new Map(),warmups=[];
  let deferAllUpdates=false;
  class Element{
    constructor(id='',tag='div'){Object.assign(this,{id,tag,value:'',disabled:false,checked:false,textContent:'',dataset:{},style:{},handlers:{},children:[],isConnected:true,attributes:{}});const classes=new Set();this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)};}
    addEventListener(type,fn){(this.handlers[type]||=[]).push(fn);}
    async fire(type='click',{force=false}={}){if(this.disabled&&!force)return;await Promise.all((this.handlers[type]||[]).map(fn=>fn({target:this,currentTarget:this,preventDefault(){}})));}
    setAttribute(key,value){this.attributes[key]=value;}
    appendChild(child){this.children.push(child);child.isConnected=true;if(child.id)nodes.set(child.id,child);return child;}
    remove(){this.isConnected=false;if(this.id)nodes.delete(this.id);for(const child of this.children)child.remove();}
    reset(){this.value='';}
    get innerHTML(){return this.markup||'';}
    set innerHTML(markup){
      for(const c of this.children){c.isConnected=false;if(c.id)nodes.delete(c.id);}
      this.markup=markup;this.children=[];
      for(const m of markup.matchAll(/<(button|input|select|textarea)[^>]*>/g)){
        const id=m[0].match(/\bid="([^"]+)"/)?.[1]||'',c=new Element(id,m[1]);
        c.disabled=/\sdisabled(?:[\s=>]|$)/.test(m[0]);
        for(const attr of m[0].matchAll(/data-([\w]+)="([^"]+)"/g))c.dataset[attr[1]]=attr[2];
        this.children.push(c);if(id)nodes.set(id,c);
      }
    }
    querySelectorAll(selector){return this.children.filter(c=>selector.split(',').some(s=>s===c.tag||(s[0]==='#'&&c.id===s.slice(1))||(s==='[data-cwchoice]'&&c.dataset.cwchoice)||(s==='[data-cwres]'&&c.dataset.cwres)));}
  }
  function node(id){if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);}
  for(const id of ['callWizModal','callWizBody','callWizErr','callWizEndBtn','takeCallBtn','nbTravelFee','nbSteps','nbSecondTechWrap','nbSecondTech','modal'])node(id);
  const ctx=vm.createContext({
    console,Set,Date,Promise,current:{slug:'doms',name:"Dom's"},businesses:[{slug:'doms',name:"Dom's"},{slug:'austin',name:'Austin'}],scope:'doms',
    crypto:webcrypto,window:{addEventListener:(type,fn)=>windowHandlers.set(type,fn)},
    document:{getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element('',tag),body:new Element('body')},nbModalSession:0,nbCalSeq:0,nbLinkedCallId:null,nbLinkedCallDraft:null,
    nbOptionGroups:[],nbQty:{},nbOptionNotes:{},nbOptionPrices:{},nbFrameTvQty:{regular:0,frame:0},nbServices:[],nbServiceId:null,
    nbAreaName:'',nbZipAreaId:null,nbConvertLines:null,nbCustomLines:[],nbSourceEstimateId:null,nbAutoTravel:'',
    nbHandymanActive:false,nbHandymanHours:0,nbHandymanLabel:'',nbHandymanNote:'',nbAssurionActive:false,nbAssurionSel:new Set(),nbGdsActive:false,nbNoChargeActive:false,nbCustomTaskActive:false,
    closeSidebar(){},renderNbConvertSummary(){},nbRenderCustomLines(){},onScreen(){return false;},openNewBooking(){},
    cwWarmTvCatalog(slug){const warm={slug,...deferred()};warmups.push(warm);return warm.promise;},
    cwLoadStripeLibrary:async()=>{},
    toast:s=>toasts.push(s),esc:String,callWizScript:s=>s,cwBackBtnHtml:()=>'',cwWireBack(){},
    HANDYMAN_HOURLY:85,TAX_RATE:0.0825,money:value=>'$'+value,
    callWizChoiceRow:opts=>opts.map(o=>`<button data-cwchoice="${o.value}">${o.label}</button>`).join(''),
    api(action,opts){const request={action,...opts};requests.push(request);if(['call_live_start','quote_economics','quote_coupon'].includes(action)||(action==='call_update'&&(deferAllUpdates||opts.body.resolution))){const d=deferred();Object.assign(request,d);return d.promise;}return Promise.resolve({ok:true});},
  });
  ctx.switchToBusiness=slug=>{ctx.current=ctx.businesses.find(b=>b.slug===slug);};
  ctx.cwHandymanHours=()=>Math.max(2,Number(ctx.draft().handymanHours)||2);
  vm.runInContext(entry+'\n'+helpers+'\n'+requestId+'\n'+roundMoney+'\n'+displayMoney+'\n'+pricing+'\n'+reset+'\n'+back+'\n'+teardown+'\n'+renderer+'\nglobalThis.draft=()=>callWiz;',ctx);
  return {ctx,node,nodes,requests,toasts,windowHandlers,warmups,deferUpdates:()=>{deferAllUpdates=true;},
    starts:()=>requests.filter(r=>r.action==='call_live_start'),ends:()=>requests.filter(r=>r.action==='call_update'&&r.body.resolution),
    choices:()=>node('callWizBody').querySelectorAll('[data-cwchoice]'),outcomes:()=>node('callWizBody').querySelectorAll('[data-cwres]'),
    async begin(reply={id:'call-1'}){ctx.openTakeCall();const run=this.choose();this.starts().at(-1).resolve(reply);await run;return ctx.draft();},
    choose(service='TV Mounting'){return this.choices().find(c=>c.dataset.cwchoice===service).fire();},
  };
}

for(const [actor,reply] of [['secretary',{id:'call-1'}],['owner',{id:null,untracked:true}]]){
  test(`${actor} can pause/resume the same phone draft without another call record`,async()=>{
    const f=setup(),draft=await f.begin(reply);draft.zip='78701';draft.cust.name='Test Caller';draft.step='schedule';
    f.ctx.closeCallWiz();f.ctx.current=f.ctx.businesses[1];f.ctx.openTakeCall();
    assert.equal(f.ctx.draft(),draft);assert.equal(draft.zip,'78701');assert.equal(draft.cust.name,'Test Caller');assert.equal(draft.step,'schedule');assert.equal(f.ctx.current.slug,'doms');assert.equal(f.starts().length,1);assert.equal(draft._visible,true);
  });
}

test('service start locks the business picker and rejects stale forced changes',async()=>{
  const f=setup();f.ctx.openTakeCall();const picker=f.node('cwBiz'),run=f.choose();
  assert.equal(picker.disabled,true);assert.ok(f.choices().every(b=>b.disabled));
  picker.value='austin';await picker.fire('change',{force:true});await f.choose();
  assert.equal(f.ctx.current.slug,'doms');assert.equal(f.starts().length,1);
  f.starts()[0].resolve({id:'call-1'});await run;assert.equal(f.ctx.draft().business,'doms');assert.equal(f.ctx.draft().step,'zip');
});

test('TV catalog warmup runs alongside logging and cannot block or repaint the ZIP card',async()=>{
  const f=setup();f.ctx.openTakeCall();const starting=f.choose();
  assert.equal(f.warmups.length,1);assert.equal(f.warmups[0].slug,'doms');assert.equal(f.starts().length,1);
  f.starts()[0].resolve({id:'call-1'});await starting;assert.equal(f.ctx.draft().step,'zip');
  const view=f.ctx.draft()._view;f.warmups[0].reject(Error('Warmup offline'));await new Promise(r=>setImmediate(r));
  assert.equal(f.ctx.draft().step,'zip');assert.equal(f.ctx.draft()._view,view);assert.equal(f.node('callWizErr').textContent,'');
  f.ctx.draft().step='greet';await f.ctx.renderCallWiz();await f.choose('Handyman');assert.equal(f.warmups.length,1);
});
test('card processor starts loading during TV questions and a failed prefetch never blocks the call',async()=>{
  const f=setup(),card=deferred();let loads=0;f.ctx.cwLoadStripeLibrary=()=>{loads++;return card.promise;};
  f.ctx.openTakeCall();const starting=f.choose();assert.equal(loads,1);assert.equal(f.starts().length,1);
  f.starts()[0].resolve({id:'call-1'});await starting;assert.equal(f.ctx.draft().step,'zip');
  card.reject(Error('processor offline'));await new Promise(r=>setImmediate(r));assert.equal(f.ctx.draft().step,'zip');assert.equal(f.node('callWizErr').textContent,'');
  f.ctx.draft().step='greet';await f.ctx.renderCallWiz();await f.choose('Handyman');assert.equal(loads,1);
});

test('a different service keeps one call record and clears only old service answers',async()=>{
  const f=setup(),draft=await f.begin();draft.zip='78701';draft.cust.name='Test Caller';draft.discManual=15;draft.step='greet';f.ctx.nbQty.size={large:2};
  await f.ctx.renderCallWiz();await f.choose('Handyman');
  assert.equal(f.ctx.draft(),draft);assert.equal(f.starts().length,1);assert.equal(draft.id,'call-1');assert.equal(draft.service,'Handyman');assert.equal(draft.zip,'78701');assert.equal(draft.cust.name,'Test Caller');assert.equal(draft.discManual,0);assert.deepEqual(Object.keys(f.ctx.nbQty),[]);
  assert.equal(f.requests.filter(r=>r.action==='call_update').at(-1).body.service,'Handyman');
});

test('a failed start can retry and shares one pending start across concurrent callers',async()=>{
  const f=setup();f.ctx.openTakeCall();let run=f.choose();f.starts()[0].reject(Error('Network unavailable'));await run;
  assert.match(f.node('callWizErr').textContent,/Network unavailable/);assert.ok(f.choices().every(b=>!b.disabled));assert.equal(f.ctx.draft()._startPromise,null);
  run=f.choose();const concurrent=f.ctx.cwStartRecord(f.ctx.draft());assert.equal(f.starts().length,2);
  assert.match(f.starts()[0].body.call_id,/^[0-9a-f-]{36}$/i);
  assert.equal(f.starts()[1].body.call_id,f.starts()[0].body.call_id,'a retry must reuse the original server identity even after a lost response');
  f.starts()[1].resolve({id:'retry-call'});await Promise.all([run,concurrent]);assert.equal(f.ctx.draft().id,'retry-call');assert.equal(f.ctx.draft().step,'zip');
});

test('a malformed start response is retryable and never advances the script',async()=>{
  const f=setup();f.ctx.openTakeCall();const run=f.choose();f.starts()[0].resolve({ok:true});await run;
  assert.equal(f.ctx.draft().step,'greet');assert.equal(f.ctx.draft()._started,false);assert.match(f.node('callWizErr').textContent,/saved record/);assert.equal(f.ctx.draft()._startPromise,null);
});

test('a detached greeting handler cannot start a call after a newer view renders',async()=>{
  const f=setup();f.ctx.openTakeCall();const stale=f.choices()[0];await f.ctx.renderCallWiz();await stale.fire('click',{force:true});
  assert.equal(f.starts().length,0);assert.equal(f.ctx.draft().service,null);
});

test('Hang up during start stays on outcome and saves against the eventual original record',async()=>{
  const f=setup();f.ctx.openTakeCall();const run=f.choose(),draft=f.ctx.draft();await f.node('callWizEndBtn').fire();
  assert.equal(draft.step,'resolution');const finish=f.outcomes()[2].fire();assert.equal(f.ends().length,0);
  f.starts()[0].resolve({id:'original-call'});await run;await new Promise(r=>setImmediate(r));
  assert.equal(draft.step,'resolution');assert.equal(f.ends().length,1);assert.equal(f.ends()[0].body.id,'original-call');
  f.ends()[0].resolve({ok:true});await finish;assert.equal(draft.resolution,'closed');f.ctx.openTakeCall();assert.notEqual(f.ctx.draft(),draft);assert.equal(f.ctx.draft().id,null);
});

test('late start response after a replacement draft cannot attach its id or navigate the new call',async()=>{
  const f=setup();f.ctx.openTakeCall();const run=f.choose(),old=f.ctx.draft();await f.node('callWizEndBtn').fire();
  // Simulates lifecycle replacement such as an explicit session handoff, not
  // a normal user close while outcome saving is locked.
  f.ctx.callWizReset();f.ctx.openTakeCall();const next=f.ctx.draft();f.starts()[0].resolve({id:'old-call'});await run;
  assert.equal(old.id,'old-call');assert.equal(f.ctx.draft(),next);assert.equal(next.id,null);assert.equal(next.step,'greet');assert.equal(next._visible,true);
});

test('returning from Hang up while start waits unlocks the newer greeting when the response arrives',async()=>{
  const f=setup();f.ctx.openTakeCall();const starting=f.choose(),draft=f.ctx.draft();await f.node('callWizEndBtn').fire();await f.node('cwBack').fire();
  assert.equal(draft.step,'greet');assert.ok(f.choices().every(b=>b.disabled));
  f.starts()[0].resolve({id:'call-1'});await starting;
  assert.equal(draft.step,'greet');assert.ok(f.choices().every(b=>!b.disabled));assert.equal(draft._startBusy,false);
  await f.choose();assert.equal(draft.step,'zip');assert.equal(f.starts().length,1);
});

test('overlay teardown snapshots and invalidates a phone view before delayed work resumes',async()=>{
  const f=setup();f.ctx.openTakeCall();const starting=f.choose(),draft=f.ctx.draft(),view=draft._view;
  f.ctx.nbQty.size={large:2};f.node('nbTravelFee').value='25';f.ctx.dismissAllOverlays();
  assert.equal(draft._visible,false);assert.ok(draft._view>view);assert.equal(f.ctx.cwIsActive(draft,view),false);assert.equal(f.node('callWizModal').classList.contains('hidden'),true);
  assert.equal(draft._quote.qty.size.large,2);assert.equal(draft._quote.travel,'25');
  const hiddenView=draft._view;f.ctx.current=null;f.starts()[0].resolve({id:'call-1'});await starting;
  assert.equal(draft._view,hiddenView);assert.equal(draft.step,'greet');assert.equal(draft._visible,false);
  f.ctx.current=f.ctx.businesses[0];f.ctx.openTakeCall();assert.equal(f.ctx.draft(),draft);assert.equal(f.ctx.nbQty.size.large,2);assert.equal(f.node('nbTravelFee').value,'25');
});

test('overlay teardown during outcome saving retains the saved outcome without reopening the modal',async()=>{
  const f=setup(),draft=await f.begin();await f.node('callWizEndBtn').fire();const finishing=f.outcomes()[2].fire();f.ctx.dismissAllOverlays();
  assert.equal(draft._visible,false);f.ends()[0].resolve({ok:true});await finishing;
  assert.equal(draft.resolution,'refused');assert.equal(draft._ending,false);assert.equal(f.node('callWizModal').classList.contains('hidden'),true);
  f.ctx.openTakeCall();assert.notEqual(f.ctx.draft(),draft);assert.equal(f.ctx.draft().step,'greet');
});

test('Hang up and Still on the call preserve a handyman description typed before Continue',async()=>{
  const f=setup(),draft=await f.begin();draft.service='Handyman';draft.step='handydesc';await f.ctx.renderCallWiz();
  f.node('cwDesc').value='Mount two shelves and secure the cabinet';await f.node('callWizEndBtn').fire();
  assert.equal(draft.handymanDesc,'Mount two shelves and secure the cabinet');assert.equal(draft.step,'resolution');
  await f.node('cwBack').fire();assert.equal(draft.step,'handydesc');assert.match(f.node('callWizBody').innerHTML,/Mount two shelves and secure the cabinet/);
});

test('terminal clicks admit one update and close only after it saves',async()=>{
  const f=setup(),draft=await f.begin();await f.node('callWizEndBtn').fire();const buttons=f.outcomes();
  const finish=buttons[0].fire();await buttons[2].fire('click',{force:true});await f.ctx.cwFinishCall('refused');
  assert.equal(f.ends().length,1);assert.equal(draft.resolution,null);assert.equal(f.node('callWizEndBtn').disabled,true);assert.ok(buttons.every(b=>b.disabled));
  f.ctx.closeCallWiz();assert.equal(draft._visible,true);
  f.ends()[0].resolve({ok:true});await finish;assert.equal(draft.resolution,'closed');assert.equal(draft._ending,false);assert.equal(f.node('callWizEndBtn').disabled,false);
});

test('outcome failure keeps the call open and enables an explicit retry',async()=>{
  const f=setup(),draft=await f.begin();await f.node('callWizEndBtn').fire();let finish=f.outcomes()[2].fire();f.ends()[0].reject(Error('Save failed'));await finish;
  assert.equal(draft.resolution,null);assert.equal(draft._visible,true);assert.equal(draft._ending,false);assert.ok(f.outcomes().every(b=>!b.disabled));assert.match(f.node('callWizErr').textContent,/Save failed/);
  finish=f.outcomes()[2].fire();f.ends()[1].resolve({ok:true});await finish;assert.equal(draft.resolution,'closed');assert.equal(f.ends()[1].body.id,'call-1');
});

test('an old outcome response cannot close a replacement draft',async()=>{
  const f=setup(),old=await f.begin();await f.node('callWizEndBtn').fire();const finish=f.outcomes()[2].fire();
  f.ctx.callWizReset();f.ctx.openTakeCall();const next=f.ctx.draft();f.ends()[0].resolve({ok:true});await finish;
  assert.equal(f.ctx.draft(),next);assert.equal(next.resolution,null);assert.equal(next._visible,true);assert.equal(f.node('callWizModal').classList.contains('hidden'),false);assert.equal(old._ending,false);
  assert.equal(f.node('callWizEndBtn').disabled,false,'a fresh call must regain its Hang up control after a session handoff');
});
test('Other outcomes save without being counted as customer declines',async()=>{
  const f=setup();await f.begin();const finishing=f.ctx.cwFinishCall('other');await new Promise(resolve=>setImmediate(resolve));
  f.ends().at(-1).resolve({ok:true});await finishing;
  assert.equal(f.requests.filter(r=>r.action==='call_event'&&r.body.event==='declined').length,0);
  assert.equal(f.ends().at(-1).body.resolution,'other');
});

test('a paused phone quote restores all shared pricing fields after the real New Booking reset',async()=>{
  const f=setup(),draft=await f.begin();draft.step='tvopts';draft.optsLoaded=true;
  Object.assign(f.ctx,{nbOptionGroups:[{id:'size',options:[{id:'large',price:125}]}],nbQty:{size:{large:2}},nbOptionNotes:{large:'Careful'},nbOptionPrices:{large:'130'},nbFrameTvQty:{regular:1,frame:1},nbServices:[{id:'tv'}],nbServiceId:'tv',nbAreaName:'Austin',nbZipAreaId:'austin-area',nbConvertLines:[{price:125}],nbCustomLines:[{price:15}],nbSourceEstimateId:'estimate-1',nbAutoTravel:'25',nbHandymanActive:true,nbHandymanHours:3,nbHandymanLabel:'Labor',nbHandymanNote:'Shelves',nbAssurionActive:true,nbAssurionSel:new Set(['service-a']),nbGdsActive:true,nbNoChargeActive:true,nbCustomTaskActive:true});
  f.node('nbTravelFee').value='25';f.ctx.closeCallWiz();const expected=copy(draft._quote);
  f.ctx.resetNbSteps();f.ctx.nbServices=[];f.ctx.nbServiceId='unrelated';f.ctx.nbAreaName='Denver';f.ctx.nbConvertLines=null;f.ctx.nbCustomLines=[];f.ctx.nbSourceEstimateId=null;f.node('nbTravelFee').value='65';f.ctx.nbAutoTravel='65';
  f.ctx.cwCaptureQuote(draft);assert.deepEqual(copy(draft._quote),expected,'a paused draft must not capture another form');
  f.ctx.openTakeCall();f.ctx.cwCaptureQuote(draft);assert.deepEqual(copy(draft._quote),expected);assert.equal(draft.optsLoaded,true);assert.equal(f.ctx.nbQty.size.large,2);
  f.ctx.nbOptionGroups[0].options[0].price=999;assert.equal(expected.groups[0].options[0].price,125);assert.equal(draft._quote.groups[0].options[0].price,125,'restored globals must not share nested objects with the saved quote');
});

test('actual New Booking open pauses the phone before resetting and cannot overwrite it on return',async()=>{
  const f=setup(),draft=await f.begin(),data=deferred();draft.step='tvopts';draft.optsLoaded=true;
  Object.assign(f.ctx,{nbOptionGroups:[{id:'size',options:[{id:'large',price:125}]}],nbQty:{size:{large:2}},nbServices:[{id:'phone-service'}],nbServiceId:'phone-service',nbAreaName:'Austin',nbZipAreaId:'area-1',nbAutoTravel:'25',nbUpsSel:{},nbUpsCustom:[],
    TEXTS_ON_LABEL:'Text customer job updates',smsConsentScript:()=>'',nbStartProgressTimer(){},attachAddressAutocomplete(){},loadNbCalendar(){},renderNbRequestedTimes(){},nbZipReplyIdle(){},nbEnsureDataCached:()=>data.promise,
  });
  f.node('nbTravelFee').value='25';f.ctx.document.getElementById=f.node;f.ctx.document.querySelector=()=>f.node('nbSubmit');
  const start=html.indexOf('async function openNewBooking(prefill){'),end=html.indexOf('\n}\n',start)+3;
  assert.ok(start>=0&&end>start);vm.runInContext(html.slice(start,end),f.ctx);
  const opening=f.ctx.openNewBooking({});
  assert.equal(draft._visible,false);assert.equal(f.ctx.nbOptionGroups.length,0);assert.equal(Object.keys(f.ctx.nbQty).length,0);
  f.ctx.openTakeCall();assert.equal(f.ctx.draft(),draft);assert.equal(f.ctx.nbQty.size.large,2);assert.equal(f.ctx.nbServiceId,'phone-service');assert.equal(f.node('nbTravelFee').value,'25');
  data.resolve({svc:{services:[{id:'unrelated-service'}]},tech:{technicians:[]}});await opening;
  assert.equal(f.ctx.nbServiceId,'phone-service');assert.equal(f.ctx.nbServices[0].id,'phone-service');assert.equal(f.ctx.nbOptionGroups[0].id,'size');assert.equal(f.ctx.nbQty.size.large,2);assert.equal(draft.optsLoaded,true);
});

test('a late TV economics result cannot authorize a discount after changing the same call to Handyman',async()=>{
  const f=setup(),draft=await f.begin();draft.step='discount';const version=draft._quoteVersion;
  const loading=f.ctx.cwLoadEconomics([{label:'TV mounting',price:300,quantity:1}],25,0);
  const request=f.requests.find(r=>r.action==='quote_economics');
  draft.step='greet';await f.ctx.renderCallWiz();await f.choose('Handyman');
  assert.equal(f.ctx.draft(),draft);assert.equal(draft.id,'call-1');assert.ok(draft._quoteVersion>version);
  request.resolve({max_discount:100,profit:200});await loading;
  assert.equal(draft.service,'Handyman');assert.equal(draft.econ,null);assert.equal(draft.econCallId,null);assert.equal(draft.preDiscountTotal,0);
});

test('a late coupon result cannot apply after changing the service on the same call',async()=>{
  const f=setup(),draft=await f.begin();draft.step='discount';draft.discRung='coupon';f.node('cwCouponInput').value='SAVE50';
  const applying=f.ctx.cwCouponApplyNow();const request=f.requests.find(r=>r.action==='quote_coupon');assert.equal(draft._couponBusy,true);
  draft.step='greet';await f.ctx.renderCallWiz();await f.choose('Handyman');
  request.resolve({ok:true,code:'SAVE50',amount:50});await applying;
  assert.equal(f.ctx.draft(),draft);assert.equal(draft.id,'call-1');assert.equal(draft.service,'Handyman');assert.equal(draft.discCoupon,null);assert.equal(draft._couponBusy,false);
  assert.equal(f.requests.filter(r=>r.action==='call_event'&&r.body.event==='coupon_applied').length,0);
});

test('an older economics response cannot replace a newer projection for the same quote',async()=>{
  const f=setup(),draft=await f.begin();draft.step='recap';
  const older=f.ctx.cwLoadEconomics([{label:'TV mounting',price:200,quantity:1}],0,0);
  const newer=f.ctx.cwLoadEconomics([{label:'TV mounting',price:400,quantity:1}],25,0);
  const requests=f.requests.filter(r=>r.action==='quote_economics');
  requests[1].resolve({max_discount:30,profit:90});await newer;assert.equal(draft.econ.max_discount,30);assert.equal(draft.preDiscountTotal,425);
  requests[0].resolve({max_discount:100,profit:150});await older;
  assert.equal(draft.econ.max_discount,30);assert.equal(draft.econ.profit,90);assert.equal(draft.preDiscountTotal,425);assert.equal(draft.econCallId,'call-1');
});

test('call detail writes finish in order and a failed older patch merges into the next save',async()=>{
  const f=setup(),draft=await f.begin();f.deferUpdates();
  const writes=()=>f.requests.filter(r=>r.action==='call_update'&&r.resolve);
  const older=f.ctx.cwCallUpdate({notes:'Initial note',service:'TV Mounting'},draft);
  const rejected=assert.rejects(older,/Temporary failure/);
  const newer=f.ctx.cwCallUpdate({notes:'Final note',resolution:'refused'},draft);
  assert.equal(writes().length,1,'the second write must not leave before the first settles');
  writes()[0].reject(Error('Temporary failure'));await rejected;await new Promise(r=>setImmediate(r));
  assert.equal(writes().length,2);
  assert.deepEqual(copy(writes()[1].body),{id:'call-1',notes:'Final note',service:'TV Mounting',resolution:'refused'});
  assert.match(f.node('cwLogStatus').innerHTML,/Some call details have not saved/);
  writes()[1].resolve({ok:true});await newer;
  assert.equal(draft._unsavedCallPatch,null);assert.equal(draft._updatePromise,null);assert.equal(f.nodes.has('cwLogStatus'),false);
});

test('failed call details stay retryable after the secretary starts a new call',async()=>{
  const f=setup(),old=await f.begin();f.deferUpdates();
  const saving=f.ctx.cwCallUpdate({notes:'Original caller note'},old),failure=assert.rejects(saving,/Offline/);
  f.requests.at(-1).reject(Error('Offline'));await failure;
  f.ctx.callWizReset();f.ctx.openTakeCall();const next=f.ctx.draft();
  const retry=f.node('cwRetryLogs').fire(),request=f.requests.at(-1);
  assert.equal(request.action,'call_update');assert.equal(request.body.id,'call-1');assert.equal(request.body.notes,'Original caller note');
  request.resolve({ok:true});await retry;
  assert.equal(f.ctx.draft(),next);assert.equal(next.id,null);assert.equal(old._unsavedCallPatch,null);
  assert.equal(f.requests.filter(r=>r.action==='booking_create'||r.action==='estimate_create').length,0,'retrying call history cannot replay customer actions');
});

test('editing the coupon while its check is pending cannot apply the previous code',async()=>{
  const f=setup(),draft=await f.begin();draft.step='discount';draft.discRung='coupon';
  for(const id of ['cwCouponInput','cwCouponApply','cwCouponMsg'])f.node(id);
  f.node('cwCouponInput').value='SAVE50';f.ctx.cwWireCouponApply();
  const applying=f.ctx.cwCouponApplyNow(),request=f.requests.find(r=>r.action==='quote_coupon');
  f.node('cwCouponInput').value='SAVE20';await f.node('cwCouponInput').fire('input');
  request.resolve({ok:true,code:'SAVE50',amount:50});await applying;
  assert.equal(draft.discCoupon,null);assert.equal(draft._couponDraft,'SAVE20');assert.equal(draft._couponBusy,false);
  assert.equal(f.node('cwCouponApply').disabled,false);assert.match(f.node('cwCouponMsg').innerHTML,/Not applied yet/);
  const corrected=f.ctx.cwCouponApplyNow(),retry=f.requests.filter(r=>r.action==='quote_coupon').at(-1);
  assert.equal(retry.body.code,'SAVE20');retry.resolve({ok:true,code:'SAVE20',amount:20});await corrected;
  assert.deepEqual(copy(draft.discCoupon),{code:'SAVE20',amount:20});
});

test('navigating away and back invalidates a pending coupon without changing the quote',async()=>{
  const f=setup(),draft=await f.begin();draft.step='discount';draft.discRung='coupon';f.node('cwCouponInput').value='SAVE50';
  const version=draft._quoteVersion,applying=f.ctx.cwCouponApplyNow(),request=f.requests.find(r=>r.action==='quote_coupon');
  draft.step='recap';await f.ctx.renderCallWiz();draft.step='discount';await f.ctx.renderCallWiz();f.node('cwCouponInput').value='SAVE50';
  request.resolve({ok:true,code:'SAVE50',amount:50});await applying;
  assert.equal(draft._quoteVersion,version);assert.equal(draft.discCoupon,null);assert.equal(draft._couponBusy,false);
  assert.equal(f.requests.filter(r=>r.action==='call_event'&&r.body.event==='coupon_applied').length,0);
});

test('browser close prompts only for an unfinished call or failed call details',async()=>{
  const f=setup();let prevented=0;
  const event=()=>({preventDefault(){prevented++;},returnValue:undefined});
  f.windowHandlers.get('beforeunload')(event());assert.equal(prevented,0);
  const draft=await f.begin();f.windowHandlers.get('beforeunload')(event());assert.equal(prevented,1);
  draft.resolution='closed';f.windowHandlers.get('beforeunload')(event());assert.equal(prevented,1);
  f.ctx.cwShowLogProblem(draft,'update',Error('Offline'));f.windowHandlers.get('beforeunload')(event());assert.equal(prevented,2);
});

test('Something else hands existing contact and ZIP to Custom Task on the same call record',async()=>{
  const f=setup(),draft=await f.begin();let prefill;
  draft.step='greet';draft.zip='78701';Object.assign(draft.cust,{name:'Test Caller',phone:'5125550100',email:'test@example.com',addr:'1 Main St',city:'Austin',state:'TX',sms:true});
  f.ctx.openNewBooking=value=>{prefill=value;};await f.ctx.renderCallWiz();await f.node('cwSomethingElse').fire();
  assert.equal(draft.service,'Other');assert.equal(draft.resolution,'closed');assert.equal(prefill._customTask,true);
  assert.equal(prefill._linkCallId,'call-1');assert.equal(prefill._linkCallDraft,draft);assert.equal(prefill.name,'Test Caller');
  assert.equal(prefill.address_line1,'1 Main St');assert.equal(prefill.postal_code,'78701');assert.equal(prefill.sms_consent,true);
  assert.equal(prefill.line_items,undefined,'changing to a custom task cannot carry unrelated TV charges');
  await new Promise(r=>setImmediate(r));f.ends().at(-1).resolve({ok:true});
});

test('a Custom Task booking corrects only its captured call and waits for its earlier Other outcome',async()=>{
  const f=setup(),old=await f.begin();f.deferUpdates();
  f.ctx.nbLinkedCallId=old.id;f.ctx.nbLinkedCallDraft=old;f.ctx.bookGate=deferred();
  const capture=cut('  const mySession=nbModalSession;   // detect close-and-reopen-for-a-new-job while in flight','  try{');
  const success=cut('      if(linkedCallDraft){','      // Only hide the modal');
  vm.runInContext('globalThis.completeCustomBooking=async function(){'+capture+'const resp=await bookGate.promise;'+success+'};',f.ctx);
  const handoff=f.ctx.cwCallUpdate({resolution:'other'},old),earlier=f.requests.at(-1);
  const booking=f.ctx.completeCustomBooking();
  const next={id:'call-2',business:'doms',_started:true};f.ctx.nbModalSession++;f.ctx.nbLinkedCallId=next.id;f.ctx.nbLinkedCallDraft=next;
  f.ctx.bookGate.resolve({id:'booking-1'});await booking;
  assert.equal(f.requests.at(-1),earlier,'booked correction must wait for the queued Other save');
  assert.equal(f.ctx.nbLinkedCallId,'call-2');assert.equal(f.ctx.nbLinkedCallDraft,next);
  earlier.resolve({ok:true});await handoff;await new Promise(r=>setImmediate(r));
  const correction=f.requests.at(-1);assert.deepEqual(copy(correction.body),{id:'call-1',resolution:'booked',booking_id:'booking-1'});
  correction.resolve({ok:true});await old._updatePromise;
});
