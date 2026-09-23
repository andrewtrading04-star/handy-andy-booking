import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
function cut(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert.ok(start>=0&&end>start,a);return html.slice(start,end);}
const money=cut('function cwRoundMoney(','// Snapshot the booking card');
const submit=cut('async function cwSubmitBooking(){','// After-hours fee for a slot');
const hold=cut('function cwHoldActions(','// Which option groups');
const pricing=cut('function cwDiscountRaw(){','// ── Concession ladder');
const stripe=cut('let cwStripe=null','// Create the booking straight from the call');
const flow=cut('async function cwGoToBooking(){','// Card entry for the call script');
const currency=cut('function cwMoneyCents(','// The five fixed slot labels');
const invalidate=cut('function cwInvalidatePrice(','// The pricing engine is shared');
const discountDetails=cut('function cwLadderSpend(){','// Whole dollars still deliverable')+cut('function cwDiscountBits(){','// Numeric, not string');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const copy=x=>JSON.parse(JSON.stringify(x));
function setup(){
  const nodes=new Map(),requests=[],tracks=[],toasts=[],alerts=[];
  function node(id){if(!nodes.has(id))nodes.set(id,{id,value:'',checked:false,disabled:false,isConnected:true,textContent:'',style:{},querySelectorAll:()=>[...nodes.values()].filter(n=>n.id!=='callWizBody'),});return nodes.get(id);}
  for(const id of ['callWizBody','callWizErr','callWizEndBtn','cwBookNow','cwEstSend','cwCustName','cwCustPhone','cwCustEmail','cwCustAddr','cwCustCity','cwCustState','cwPayMethod','cwSkipCard','cwSmsConsent'])node(id);
  Object.entries({cwCustName:'Test Person',cwCustPhone:'2025550147',cwCustEmail:'test@example.com',cwCustAddr:'123 Test St',cwCustCity:'Denver',cwCustState:'CO',cwPayMethod:'card'}).forEach(([k,v])=>node(k).value=v);
  const draft={id:'call-1',business:'doms',service:'TV Mounting',_visible:true,_view:1,_quoteVersion:1,_ending:false,resolution:null,step:'customer',surcharge:25,prefDate:'2026-10-04',selectedSlot:{key:'20:00',label:'8 PM'},cust:{sms:true},estimateContact:{name:'Test Person',phone:'2025550147',email:'test@example.com'},discSource:'Google',discCoupon:null,discManual:0,econ:{max_discount:30},discountLabel:'Discount (heard via Google)'};
  let cardCalls=0,renderCalls=0,refreshCalls=0;
  const ctx=vm.createContext({console,crypto:webcrypto,Uint8Array,Promise,Set,Map,Date,callWiz:draft,TAX_RATE:.0825,NB_MINIMUM:139,CW_SOURCE_DISCOUNT:10,CW_ATTRIB_ORDER:['coupon','source','manual'],userName:'Test Secretary',
    document:{getElementById:id=>nodes.get(id)||null},lines:[{label:'TV mounting',option_id:'tv',price:139,quantity:1}],validation:null,carriedTravel:false,ah:100,verified:true,pair:false,
    nbCollectSelections(){return copy(ctx.lines);},cwValidateTvAnswers(){return ctx.validation;},nbCarriedTravelLine(){return ctx.carriedTravel;},cwAfterHoursFeeFor(){return ctx.ah;},cwHandymanLine(){return {label:'Handyman Labor: Shelves',price:85,quantity:2};},
    cwIsActive(d,v){return ctx.callWiz===d&&d._visible&&!d.resolution&&(v==null||d._view===v);},
    cwSlotIsVerified(){return ctx.verified;},cwScheduleParams(){return {pool:'own',...(ctx.pair?{secondary_technician_id:'any',pool2:'own'}:{})};},nbSelectedLiftingKind(){return ctx.pair?'98plus':null;},nbServiceId:'service-tv',nbTotalTvs:()=>1,
    cwSaveCust(){draft.cust.sms=node('cwSmsConsent').checked;},cwCaptureQuote(){},cwSetDiscountLabel(){draft.discountLabel='Discount (heard via Google)';},cwEconState:()=>ctx.econState,
    econState:'ready',nbWithTimeout:p=>p,currentNbStripePk:()=> 'pk_test',
    window:{Stripe:()=>({elements:()=>({create:()=>({mount(){},destroy(){}})}),createPaymentMethod:async()=>{cardCalls++;return {paymentMethod:{id:'pm_fixture'}};}})},
    cwCallUpdate(p,d){tracks.push({update:copy(p),draft:d});return Promise.resolve({ok:true});},cwTrack(e,m,d){tracks.push({event:e,meta:copy(m),draft:d});},
    api(action,opts){const wait=deferred();requests.push({action,...opts,...wait});return wait.promise;},
    apiConfirmUnavailable(action,body){return ctx.api(action,{body});},
    renderCallWiz(){renderCalls++;},closeCallWiz(opts,d){d.resolution='closed';d._visible=false;},toast:m=>toasts.push(m),alert:m=>alerts.push(m),refreshCurrent(){refreshCalls++;},money:n=>'$'+n,
  });
  vm.runInContext(pricing+'\n'+money+'\n'+currency+'\n'+discountDetails+'\n'+invalidate+'\n'+hold+'\n'+stripe+'\n'+flow+'\n'+submit,ctx);
  vm.runInContext("cwStripe=window.Stripe('pk_test');cwStripeCard={};cwStripePk='pk_test';",ctx);
  draft._acceptedQuote=ctx.cwBuildQuote();node('cwSmsConsent').checked=true;
  return {ctx,draft,node,nodes,requests,tracks,toasts,alerts,cardCalls:()=>cardCalls,renderCalls:()=>renderCalls,refreshCalls:()=>refreshCalls};
}

test('one quote carries TV price, travel, Sunday after-hours, discount and exact tax',()=>{
  const f=setup(),q=f.ctx.cwBuildQuote();
  assert.equal(q.preDiscount,264);assert.equal(q.discount,10);assert.equal(q.subtotal,254);assert.equal(q.tax,20.96);assert.equal(q.total,274.96);
  assert.deepEqual(copy(q.selections).map(l=>l.price),[139,25,100,-10]);
});
test('negative travel remains a discount in the same written and booked quote',()=>{
  const f=setup();f.draft.surcharge=-15;f.ctx.ah=0;
  const q=f.ctx.cwBuildQuote();
  assert.equal(q.subtotal,128.41);assert.equal(q.tax,10.59);assert.equal(q.total,139);assert.equal(q.discount,0);
  assert.equal(q.selections[1].label,'Travel discount');assert.equal(q.selections[1].price,-15);
  assert.deepEqual(copy(q.selections[2]),{option_id:null,label:'Service minimum adjustment',price:4.41,quantity:1});
  assert.equal(q.priced.at(-1).price,4.41,'economics receives the same visible adjustment');
});

test('the minimum cap keeps applied discount, manual label and booked total consistent to the cent',()=>{
  const f=setup();f.draft.surcharge=-5;f.ctx.ah=0;f.draft.discSource=null;f.draft.discManual=500;f.draft.econ.max_discount=500;
  let q=f.ctx.cwBuildQuote();f.ctx.cwSetDiscountLabel();q=f.ctx.cwBuildQuote();
  assert.equal(q.preDiscount,134);assert.equal(q.discount,5.59);assert.equal(f.ctx.cwDiscountApplied(),5.59);
  assert.equal(f.ctx.cwLadderSpend().eff.manual,5.59);assert.match(f.draft.discountLabel,/manual \$5.59/);
  assert.equal(q.selections.at(-1).price,-5.59);assert.equal(q.subtotal,128.41);assert.equal(q.total,139);
});

test('minimum adjustment preserves ordinary higher quotes and the Handyman exemption',()=>{
  const higher=setup();higher.draft.surcharge=-5;higher.ctx.ah=0;higher.draft.discSource=null;
  assert.equal(higher.ctx.cwBuildQuote().total,145.06);assert.ok(!higher.ctx.cwBuildQuote().selections.some(l=>l.label==='Service minimum adjustment'));
  const handy=setup();handy.draft.service='Handyman';handy.draft.surcharge=-50;handy.ctx.ah=0;
  const q=handy.ctx.cwBuildQuote();assert.equal(q.subtotal,120);assert.equal(q.total,129.9);assert.ok(!q.selections.some(l=>l.label==='Service minimum adjustment'));
});

test('minimum adjustment is stable across recap and booking acceptance and written estimates',async()=>{
  for(const estimate of [false,true]){
    const f=setup();f.draft.surcharge=-15;f.ctx.ah=0;f.draft.step=estimate?'estimate':'recap';
    if(!estimate)await f.ctx.cwGoToBooking();
    const run=estimate?f.ctx.cwSubmitEstimate():f.ctx.cwSubmitBooking();await flush();
    assert.equal(f.requests.length,1);const request=f.requests[0];
    assert.equal(request.body.selections.filter(l=>l.label==='Service minimum adjustment').length,1);
    assert.equal(request.body.selections.find(l=>l.label==='Travel discount').price,-15);
    if(!estimate)assert.equal(request.body.price,139);
    else {const subtotal=request.body.selections.reduce((sum,l)=>sum+l.price*l.quantity,0);assert.equal(Math.round(subtotal*(1+request.body.tax_rate)*100)/100,139);}
    request.resolve(estimate?{id:'estimate-floor',emailed:true}:{id:'booking-floor'});await run;
  }
});
test('carried travel and after-hours lines are never duplicated',()=>{
  const f=setup();f.ctx.carriedTravel=true;f.ctx.lines.push({label:'Travel',price:25,quantity:1},{label:'After-hours',price:100,quantity:1});
  const q=f.ctx.cwBuildQuote();assert.equal(q.preDiscount,264);assert.equal(q.selections.length,4);
});
test('incomplete TV answers, empty pricing, invalid numbers and zero-price quotes cannot advance',()=>{
  for(const change of [f=>f.ctx.validation='Answer wall type for every TV',f=>f.ctx.lines=[],f=>f.ctx.lines[0].price=NaN,f=>f.ctx.lines[0].quantity=Infinity,f=>{f.ctx.lines[0].price=0;f.draft.surcharge=0;f.ctx.ah=0;}]){
    const f=setup();change(f);assert.throws(()=>f.ctx.cwBuildQuote());
  }
});
test('handyman quote uses the hourly line and does not inherit TV discounts',()=>{
  const f=setup();f.draft.service='Handyman';f.ctx.ah=0;const q=f.ctx.cwBuildQuote();assert.equal(q.subtotal,195);assert.equal(q.discount,0);assert.match(q.selections[0].label,/Handyman Labor/);
});
test('fractional money is rounded once to cents and finite discount ceilings fail closed',()=>{
  const f=setup();f.ctx.lines[0].price=139.19;f.draft.surcharge=25.35;f.ctx.ah=0;f.draft.discManual=Infinity;f.draft.econ.max_discount=Infinity;
  const q=f.ctx.cwBuildQuote();assert.equal(q.subtotal,164.54);assert.equal(q.discount,0);assert.equal(q.tax,13.57);assert.equal(q.total,178.11);
});
test('customer validation rejects incomplete contact and service address before tokenizing a card',async()=>{
  for(const [field,bad] of [['cwCustPhone','123'],['cwCustEmail','test@'],['cwCustName',''],['cwCustAddr',''],['cwCustCity',''],['cwCustState','']]){
    const f=setup();f.node(field).value=bad;await f.ctx.cwSubmitBooking();assert.equal(f.requests.length,0);assert.equal(f.cardCalls(),0);assert.ok(f.node('callWizErr').textContent);
  }
});
test('an unverified slot or price changed after acceptance blocks booking',async()=>{
  for(const change of [f=>f.ctx.verified=false,f=>f.ctx.lines[0].price=159,f=>f.draft._quoteVersion++]){
    const f=setup();change(f);await f.ctx.cwSubmitBooking();assert.equal(f.requests.length,0);assert.ok(f.node('callWizErr').textContent);
  }
});
test('booking sends exactly the accepted quote and the availability staffing requirement',async()=>{
  const f=setup();f.ctx.pair=true;const run=f.ctx.cwSubmitBooking();await flush();const r=f.requests[0];
  assert.equal(r.body.secondary_technician_id,'any');assert.equal(r.body.needs_lifting,true);assert.equal(r.body.price,274.96);assert.deepEqual(copy(r.body.selections),copy(f.draft._acceptedQuote.selections));assert.equal(r.body.payment_method_id,'pm_fixture');
  r.resolve({id:'booking-1'});await run;assert.equal(f.draft.resolution,'closed');assert.equal(f.cardCalls(),1);
});
test('lost booking response retries one frozen key and payload without another card token',async()=>{
  const f=setup();let run=f.ctx.cwSubmitBooking();await flush();const first=f.requests[0];first.reject(new Error('Connection dropped'));await run;
  assert.ok(f.draft._bookingAttempt);assert.match(f.node('callWizErr').textContent,/same request safely/);
  f.node('cwCustPhone').value='999';run=f.ctx.cwSubmitBooking();await flush();const second=f.requests[1];
  assert.deepEqual(copy(second.body),copy(first.body));assert.equal(f.cardCalls(),1);second.resolve({id:'booking-1',duplicate:true});await run;assert.equal(f.draft.resolution,'closed');
});
test('malformed successful booking response remains a retry of the original booking',async()=>{
  const f=setup();let run=f.ctx.cwSubmitBooking();await flush();f.requests[0].resolve({ok:true});await run;assert.ok(f.draft._bookingAttempt);assert.equal(f.draft.resolution,null);
  run=f.ctx.cwSubmitBooking();await flush();assert.equal(f.requests[1].body.idempotency_key,f.requests[0].body.idempotency_key);f.requests[1].resolve({id:'saved'});await run;
});
test('definitive booking rejection clears pending request so answers can be corrected',async()=>{
  const f=setup();const run=f.ctx.cwSubmitBooking();await flush();f.requests[0].reject(Object.assign(new Error('Time is no longer available'),{status:409}));await run;assert.equal(f.draft._bookingAttempt,null);assert.match(f.node('callWizErr').textContent,/no longer available/);assert.equal(f.draft._ending,false);
});

// Execute the real renderer's pending-save blocks. Recreating controls mirrors
// innerHTML replacement in the browser; old disabled controls must not survive
// a definitive rejection of a previously uncertain save.
function usePendingSaveRenderer(f,kind){
  const field=kind==='booking'?'_bookingAttempt':'_estimateAttempt';
  const step=kind==='booking'?'customer':'estimate';
  const branch=html.indexOf(`if(s==='${step}'){`);
  const start=html.indexOf(`if(draft.${field}){`,branch);
  const end=html.indexOf('    return;',start);
  assert.ok(branch>=0&&start>branch&&end>start);
  const block=html.slice(start,end);
  const ids=kind==='booking'
    ? ['cwCustName','cwCustPhone','cwCustEmail','cwCustAddr','cwCustCity','cwCustState','cwPayMethod','cwSkipCard','cwSmsConsent']
    : ['cwName','cwPhone','cwEmail','cwEstSmsConsent'];
  const back=kind==='booking'?'cwCustBack':'cwEstBack',send=kind==='booking'?'cwBookNow':'cwEstSend';
  [...ids,back,send].forEach(id=>f.node(id));
  f.node('callWizBody').querySelectorAll=selector=>selector==='input,select,textarea'
    ? ids.map(id=>f.node(id))
    : [...ids,back,send].map(id=>f.node(id));
  let renders=0;
  f.ctx.renderCallWiz=()=>{
    renders++;
    for(const id of [...ids,back,send]){
      const old=f.node(id);old.isConnected=false;
      f.nodes.set(id,{...old,disabled:false,isConnected:true});
    }
    vm.runInContext(`{const draft=callWiz,body=document.getElementById('callWizBody'),err=document.getElementById('callWizErr');${block}}`,f.ctx);
  };
  f.draft.step=step;
  return {ids,back,send,renders:()=>renders};
}
for(const kind of ['booking','estimate'])test(`uncertain ${kind} then definitive rejection restores editable fields and Back`,async()=>{
  const f=setup(),ui=usePendingSaveRenderer(f,kind),submit=()=>kind==='booking'?f.ctx.cwSubmitBooking():f.ctx.cwSubmitEstimate();
  let run=submit();await flush();f.requests[0].reject(new Error('Connection dropped'));await run;
  assert.ok(ui.ids.every(id=>f.node(id).disabled));assert.equal(f.node(ui.back).disabled,true);
  const renders=ui.renders();
  run=submit();await flush();f.requests[1].reject(Object.assign(new Error('Correct the customer details and retry'),{status:400}));await run;
  assert.equal(f.draft[kind==='booking'?'_bookingAttempt':'_estimateAttempt'],null);
  assert.ok(ui.ids.every(id=>!f.node(id).disabled));assert.equal(f.node(ui.back).disabled,false);assert.equal(f.node(ui.send).disabled,false);
  assert.equal(ui.renders(),renders+1);assert.equal(f.draft._ending,false);assert.match(f.node('callWizErr').textContent,/Correct the customer details/);
  run=submit();await flush();assert.equal(f.requests.length,3,'the corrected form can submit again');
  f.requests[2].resolve(kind==='booking'?{id:'saved'}:{id:'saved',emailed:true});await run;
  assert.equal(f.draft.resolution,'closed');
});
test('a lost staffing slot sends the secretary back to scheduling with contact details preserved',async()=>{
  const f=setup();const run=f.ctx.cwSubmitBooking();await flush();assert.equal(f.requests[0].body.require_available,true);
  let aborted=false;f.draft._calendarRequest={controller:{abort(){aborted=true;}}};f.draft._calendarSnapshot={slots_by_date:{}};
  f.requests[0].reject(Object.assign(new Error('Choose another time'),{status:409,code:'slot_unavailable'}));await run;
  assert.equal(aborted,true);assert.equal(f.draft._calendarRequest,null);assert.equal(f.draft._calendarSnapshot,null);
  assert.equal(f.draft.step,'schedule');assert.equal(f.draft.selectedSlot,null);assert.equal(f.draft._slotVerifiedKey,null);assert.equal(f.node('cwCustPhone').value,'2025550147');
});
test('fractional displayed totals retain cents instead of rounding up the customer price',()=>{
  const f=setup();assert.equal(f.ctx.cwMoney(816.21),'$816.21');assert.equal(f.ctx.cwMoney(139),'$139');assert.equal(f.ctx.cwMoney(-10.23),'-$10.23');
});
test('discount descriptions show the money actually given when a manual request exceeds the ceiling',()=>{
  const f=setup();f.draft.discManual=500;f.ctx.cwSetDiscountLabel();assert.equal(f.ctx.cwDiscountApplied(),30);assert.match(f.draft.discountLabel,/manual \$20/);assert.doesNotMatch(f.draft.discountLabel,/500/);
});
test('double-click booking submits once and late success does not close a different call',async()=>{
  const f=setup();const run=f.ctx.cwSubmitBooking();await f.ctx.cwSubmitBooking();await flush();assert.equal(f.requests.length,1);
  const replacement={_visible:true,resolution:null};f.ctx.callWiz=replacement;f.requests[0].resolve({id:'saved'});await run;assert.equal(replacement.resolution,null);assert.equal(f.draft.resolution,'booked');
});
test('estimate includes the identical after-hours quote and explicit tax rate',async()=>{
  const f=setup();f.draft.step='estimate';const run=f.ctx.cwSubmitEstimate();const r=f.requests[0];assert.equal(r.action,'estimate_create');assert.equal(r.body.tax_rate,.0825);assert.deepEqual(copy(r.body.selections),copy(f.draft._acceptedQuote.selections));
  assert.match(r.body.estimate_id,/^[0-9a-f-]{36}$/);r.resolve({id:'estimate-1',emailed:true});await run;assert.match(f.toasts[0],/emailed/);
});
test('uncertain estimate retry uses the same UUID and never claims a delivery without evidence',async()=>{
  const f=setup();f.draft.step='estimate';let run=f.ctx.cwSubmitEstimate();f.requests[0].reject(new Error('Timeout'));await run;
  run=f.ctx.cwSubmitEstimate();assert.deepEqual(copy(f.requests[1].body),copy(f.requests[0].body));f.requests[1].resolve({id:'estimate-1',duplicate:true,delivery_unknown:true});await run;
  assert.match(f.toasts[0],/check delivery/);assert.equal(f.tracks.filter(x=>x.event==='estimate_sent').length,0);assert.equal(f.tracks.find(x=>x.update).update.resolution,'other');
});
test('estimate requires valid contact, consent for text-only, and a checked discount',async()=>{
  for(const change of [f=>f.draft.estimateContact.email='invalid',f=>{f.draft.estimateContact.email='';f.draft.cust.sms=false;},f=>f.ctx.econState='loading',f=>f.draft._couponBusy=true]){
    const f=setup();f.draft.step='estimate';change(f);await f.ctx.cwSubmitEstimate();assert.equal(f.requests.length,0);assert.ok(f.node('callWizErr').textContent);
  }
});
test('accepting a discounted quote snapshots the final label before booking validation',async()=>{
  const f=setup();f.draft.step='discount';f.draft.discountLabel=null;await f.ctx.cwGoToBooking();assert.equal(f.draft.step,'customer');assert.deepEqual(copy(f.draft._acceptedQuote.selections),copy(f.ctx.cwBuildQuote().selections));
});
test('acceptance without a verified slot returns to scheduling before customer details',async()=>{
  const f=setup();f.draft.step='discount';f.ctx.verified=false;await f.ctx.cwGoToBooking();assert.equal(f.draft.step,'schedule');assert.equal(f.requests.length,0);
});
test('card library and same-view mounting are shared so toggling payment does not clear a card',async()=>{
  const f=setup();let creates=0,destroys=0;f.ctx.window.Stripe=()=>({elements:()=>({create:()=>{creates++;return {mount(){},destroy(){destroys++;}};}})});
  const p=f.ctx.cwEnsureStripe();assert.equal(f.ctx.cwEnsureStripe(),p);await p;await f.ctx.cwEnsureStripe();assert.equal(creates,1);assert.equal(destroys,0);
});
test('card load completion cannot mount in another view or after leaving card payment',async()=>{
  for(const change of [f=>f.draft._view++,f=>f.node('cwPayMethod').value='cash']){
    const f=setup();let creates=0;f.ctx.window.Stripe=()=>{creates++;return {};};const p=f.ctx.cwEnsureStripe();change(f);await assert.rejects(p,/closed/);assert.equal(creates,0);
  }
});
