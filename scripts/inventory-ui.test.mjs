import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const admin=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const tech=fs.readFileSync(new URL('../public/tech.html',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function segment(source,start,end){const a=source.indexOf(start);assert(a>=0,start);const b=source.indexOf(end,a);assert(b>a,end);return source.slice(a,b);}
function setup(extra={}){
  const c=vm.createContext({crypto:webcrypto,esc,window:{},document:{hidden:false},current:{slug:'demo'},section:'brackets',api:async()=>({}),toast(){},console,setInterval:()=>1,clearInterval(){},...extra});
  vm.runInContext(segment(admin,'let inventoryHistoryPage=','// Friendly status pill'),c);
  vm.runInContext(segment(admin,'const LOW_BRACKETS_MAX=','// Jump to the Bracket Inventory section'),c);
  vm.runInContext(segment(admin,'function inventoryRecountPayload(','function openBracketEdit('),c);
  return c;
}
function recountForm(values={},selected=['flat']){
  const inputs={};for(const type of ['flat','tilting','full_motion']){inputs[`[name="count_${type}"]`]={checked:selected.includes(type)};inputs[`#recount_${type}`]={value:String(values[type]??5),focus(){}};}
  inputs['[name=notes]']={value:'Counted by technician in truck',focus(){}};
  return {dataset:{countedAt:new Date().toISOString()},querySelector:s=>inputs[s]};
}
const baseline={technician_id:'A',updated_at:'2026-09-16T00:00:00Z'};

test('inline scripts in both changed pages remain valid JavaScript',()=>{
  for(const source of [admin,tech])for(const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
});
test('low stock remains visible with incoming stock, individually per type',()=>{
  const c=setup(),t={flat:0,tilting:2,full_motion:3,_incoming_flat:20,_incoming_tilting:1};
  assert.deepEqual(Array.from(c.invLowBracketTypes(t)),['flat','tilting']);
});
test('same-name techs receive incoming quantities by ID',()=>{
  const c=setup(),rows=[{technician_id:'A',technician_name:'Same'},{technician_id:'B',technician_name:'Same'}];
  c.attachIncomingStock(rows,[{technician_id:'A',technician_name:'Same',status:'in_route',flat_qty:4}],[]);
  assert.equal(rows[0]._incoming_flat,4);assert.equal(rows[1]._incoming_flat,0);
});
test('partial receipts contribute only outstanding quantities',()=>{
  const c=setup(),rows=[{technician_id:'A'}];
  c.attachIncomingStock(rows,[{technician_id:'A',status:'partially_delivered',flat_qty:5,received_flat:3}],[]);
  assert.equal(rows[0]._incoming_flat,2);
});
test('canceled and delivered purchases do not contribute incoming stock',()=>{
  const c=setup(),rows=[{technician_id:'A'}];
  c.attachIncomingStock(rows,['canceled','cancelled','delivered','returned'].map(status=>({status,technician_id:'A',flat_qty:4})),[]);
  assert.equal(rows[0]._incoming_flat,0);
});
test('all open orders contribute even beyond 20 history records',()=>{
  const c=setup(),rows=[{technician_id:'A'}];
  c.attachIncomingStock(rows,Array.from({length:31},(_,i)=>({id:String(i),technician_id:'A',status:'in_route',flat_qty:1})),[]);
  assert.equal(rows[0]._incoming_flat,31);
});
test('overdue replenishment is visible while zero physical stock stays low',()=>{
  const c=setup(),rows=[{technician_id:'A',flat:0}];
  c.attachIncomingStock(rows,[{technician_id:'A',status:'in_route',flat_qty:1,estimated_delivery:'2020-01-01'}],[]);
  assert.equal(c.invLowType(rows[0],'flat'),true);assert.match(c.inventoryRestockHtml(rows[0],'flat'),/overdue/);
});
test('insufficient incoming amount is stated separately',()=>{
  const c=setup();assert.match(c.inventoryRestockHtml({flat:0,_incoming_flat:1},'flat'),/still 2 or fewer/);
});
test('recount sends only explicitly selected type and expected version',()=>{
  const c=setup(),payload=c.inventoryRecountPayload(recountForm({flat:6,tilting:5}),baseline);
  assert.equal(payload.flat,6);assert.equal(Object.hasOwn(payload,'tilting'),false);assert.equal(Object.hasOwn(payload,'full_motion'),false);assert.equal(payload.expected_updated_at,baseline.updated_at);
});
test('new stock account uses explicit uninitialized version',()=>{
  const c=setup();assert.equal(c.inventoryRecountPayload(recountForm(),{technician_id:'A'}).expected_updated_at,'uninitialized');
});
test('recount rejects blank, decimal, negative, and nonnumeric selected values',()=>{
  const c=setup();for(const value of ['',2.5,-1,'not a count'])assert.throws(()=>c.inventoryRecountPayload(recountForm({flat:value}),baseline),/whole number/);
});
test('unchecked types are ignored even if their stale input is invalid',()=>{
  const c=setup();assert.equal(c.inventoryRecountPayload(recountForm({flat:0,tilting:'bad'}),baseline).flat,0);
});
test('recount requires selected types and meaningful reason',()=>{
  const c=setup();assert.throws(()=>c.inventoryRecountPayload(recountForm({},[]),baseline),/Choose/);
  const form=recountForm();form.querySelector('[name=notes]').value='fix';assert.throws(()=>c.inventoryRecountPayload(form,baseline),/Explain/);
});
test('failed request retry retains operation ID and disallows changing its payload',async()=>{
  const requests=[],c=setup({api:async(action,request)=>{requests.push(request);if(requests.length===1)throw new Error('network unavailable');return {ok:true};}}),form={dataset:{operationId:'stable-id'}},body={flat:2};
  await assert.rejects(c.inventoryPost('bracket_transfer',body,form));await c.inventoryPost('bracket_transfer',body,form);
  assert.equal(requests[0].body.operation_id,requests[1].body.operation_id);
  await assert.rejects(c.inventoryPost('bracket_transfer',{flat:3},form),/already attempted/);
});
test('a review response never passes as a confirmed receipt',async()=>{
  const c=setup({api:async()=>({ok:true,inventory_status:'review',review_reason:'legacy_receipt_requires_review'})});
  await assert.rejects(c.inventoryPost('bracket_receive',{received_flat:2},{dataset:{operationId:'review-id'}}),/needs review/);
  assert.equal(vm.runInContext('inventoryRefreshPending',c),true);
});
test('pending API current quantity names retain actionable unassigned orders only',()=>{
  const c=setup();const rows=c.inventoryPendingRows([{id:'a',flat_qty:3,tilting_qty:1,total_qty:4,status:'in_route'},{id:'c',flat_qty:8,total_qty:8,status:'canceled'}]);
  assert.equal(rows.length,1);assert.equal(rows[0].flat,3);assert.equal(rows[0].total,4);
});
test('automatic refresh defers while editing, and skips hidden/inactive pages',()=>{
  let calls=0;const c=setup();c.renderBrackets=()=>{calls++};c.window.inventoryModal={};c.refreshInventorySnapshot();assert.equal(calls,0);assert.equal(vm.runInContext('inventoryRefreshPending',c),true);c.window.inventoryModal=null;c.document.hidden=true;c.refreshInventorySnapshot();assert.equal(calls,0);c.document.hidden=false;c.section='schedule';c.refreshInventorySnapshot();assert.equal(calls,0);c.section='brackets';c.refreshInventorySnapshot();assert.equal(calls,1);
});
test('inventory fetch consumes independent open_orders and excludes canceled pending rows',async()=>{
  const view={innerHTML:''},requests=[];
  const c=setup({document:{hidden:false,getElementById:()=>view},window:{scrollY:0},role:'owner',syncStatHtml:()=>'',api:async(action,args)=>{
    requests.push({action,args});
    if(action==='bracket_inventory')return{inventory:[{technician_id:'A',technician_name:'Example',flat:0,tilting:5,full_motion:5}]};
    if(action==='bracket_purchases')return{purchases:[{id:'history',status:'delivered',flat_qty:9}],open_orders:[{id:'older-open',technician_id:'A',technician_name:'Example',status:'in_route',flat_qty:4}],has_more:true};
    if(action==='bracket_pending')return{pending:[{id:'canceled',walmart_order_num:'CANCEL-UNIQUE',status:'canceled',total:5}]};
    return{orders:[],exceptions:[]};
  }});
  vm.runInContext(segment(admin,'function bracketStatusBadge(','// Assign modal:'),c);
  vm.runInContext(segment(admin,'async function renderBrackets(','// Assign a just-delivered bracket order'),c);
  await c.renderBrackets();
  assert.equal(c.window._bracketInv[0]._incoming_flat,4);
  assert.match(view.innerHTML,/Open Walmart orders — shipments and review/);
  assert.match(view.innerHTML,/Next page/);assert.doesNotMatch(view.innerHTML,/CANCEL-UNIQUE/);
  assert.match(view.innerHTML,/Physical count: not verified/);assert.match(view.innerHTML,/Inventory refreshed:/);
  assert.equal(requests.find(r=>r.action==='bracket_purchases').args.params.history_page,'0');
});
function techSetup(extra={}){const c=vm.createContext({crypto:webcrypto,esc,console,...extra});vm.runInContext(segment(tech,'const techInventoryOperations=','async function showDetail('),c);return c;}
const materialJob={id:'job',status:'in_progress',payment_status:'unpaid',inventory_materials:{flat:1,tilting:0,full_motion:0},inventory_status:'unrecorded',bracket:{techs:[{id:'A',name:'Example'}]},li_rev:2};
test('actual-use control is available before payment and photos',()=>{const c=techSetup();assert.match(c.inventoryUseCard(materialJob),/Confirm brackets actually used/);});
test('recorded or canceled job does not offer another actual-use submission',()=>{const c=techSetup();for(const patch of [{inventory_status:'recorded'},{status:'canceled'}])assert.doesNotMatch(c.inventoryUseCard({...materialJob,...patch}),/id="inventoryUseSave"/);});
test('tech review messages are escaped and visible',()=>{const c=techSetup();const html=c.inventoryUseCard({...materialJob,inventory_issues:[{message:'<script>bad</script>'}]});assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);});
test('tech material-use retry uses same operation and structured server revision',async()=>{
  const requests=[],button={},error={},select={value:'A'},c=techSetup({document:{getElementById:id=>({inventoryUseSave:button,inventoryUseError:error,inventoryUseSupplier:select})[id]},confirm:()=>true,toast(){},showDetail:async()=>{},api:async(action,args)=>{requests.push({action,...args});if(requests.length===1)throw new Error('temporary failure');return{inventory_status:'recorded'};}});
  c.bindInventoryUse(materialJob,'job');await button.onclick();assert.equal(button.disabled,false);await button.onclick();assert.equal(requests.length,2);assert.equal(requests[0].body.operation_id,requests[1].body.operation_id);assert.equal(requests[0].body.li_rev,2);assert.equal(requests[0].body.bracket_supplied_by,'A');
});
test('supplier Save sends loaded revision and retains operation after a failed request',async()=>{
  const requests=[],button={},select={value:'A'},job={li_rev:2},messages=[];
  const c=techSetup({document:{getElementById:id=>({bracketSave:button,bracketTech:select})[id]},toast:m=>messages.push(m),inventorySaveFeedback(){},showDetail:async()=>{},api:async(action,args)=>{requests.push({action,...args});throw new Error('inventory_line_items_conflict');}});
  c.bindBracketSupplier(job,'job');job.li_rev=9;await button.onclick();assert.equal(button.disabled,false);assert.equal(select.disabled,false);
  await button.onclick();assert.equal(requests[0].action,'job_bracket_supplier');assert.equal(requests[0].body.li_rev,2);assert.equal(requests[1].body.li_rev,2);assert.equal(requests[0].body.technician_id,'A');assert.ok(requests[0].body.operation_id);assert.equal(requests[0].body.operation_id,requests[1].body.operation_id);assert.match(messages[0],/conflict/);
});
test('supplier operation changes only for a new selection or loaded revision, surviving rebinding',async()=>{
  const requests=[],button={},select={value:'A'};
  const c=techSetup({document:{getElementById:id=>({bracketSave:button,bracketTech:select})[id]},toast(){},inventorySaveFeedback(){},showDetail:async()=>{},api:async(action,args)=>{requests.push(args.body);throw new Error('network unavailable');}});
  c.bindBracketSupplier({li_rev:2},'job');await button.onclick();select.onchange();await button.onclick();assert.equal(requests[0].operation_id,requests[1].operation_id);
  c.bindBracketSupplier({li_rev:2},'job');await button.onclick();assert.equal(requests[0].operation_id,requests[2].operation_id);
  select.value='B';select.onchange();await button.onclick();assert.notEqual(requests[0].operation_id,requests[3].operation_id);
  select.value='A';select.onchange();await button.onclick();assert.notEqual(requests[0].operation_id,requests[4].operation_id);
  c.bindBracketSupplier({li_rev:3},'job');await button.onclick();assert.notEqual(requests[4].operation_id,requests[5].operation_id);assert.equal(requests[5].li_rev,3);
});
function loadFeedback(c,source){vm.runInContext(segment(source,'function inventoryMaterialFields(',source===admin?'// Add the $70 two-person fee':'const techInventoryOperations='),c);}
test('office status update explicitly alerts when job succeeds but stock needs review',async()=>{
  const alerts=[],toasts=[];let refreshed=false;const c=vm.createContext({current:{slug:'demo'},apiConfirmUnavailable:async()=>({ok:true,inventory_status:'review',review_reason:'supplier_required'}),toast:m=>toasts.push(m),alert:m=>alerts.push(m),refreshCurrent:()=>{refreshed=true}});
  loadFeedback(c,admin);vm.runInContext(segment(admin,'async function updateBooking(','// Show the signed authorization'),c);
  await c.updateBooking({id:'job',action:'status',status:'completed'});assert.equal(refreshed,true);assert.match(alerts[0],/Bracket stock needs review/);assert.match(toasts[0],/supplier required/);
});
test('tech completion event shows shortfall rather than blanket inventory success',async()=>{
  const handlers={},alerts=[];let completed=false;const c=vm.createContext({document:{getElementById:id=>({classList:{add(){}},addEventListener:(event,fn)=>{handlers[id]=fn}})},api:async()=>({ok:true,inventory_status:'shortfall'}),toast(){},alert:m=>alerts.push(m),syncJobStatus:()=>{completed=true},showDetail(){},completePending:{id:'job'}});
  loadFeedback(c,tech);vm.runInContext(segment(tech,'function closeCompleteModal()','// "Get the logo on the TV"'),c);
  await handlers.completeYes();assert.equal(completed,true);assert.match(alerts[0],/stock needs office review/);
});
test('tech line save preserves loaded material identity and displays review result',async()=>{
  const elements={liEditor:{innerHTML:'',querySelectorAll:()=>[]},liAdd:{},liSave:{}},alerts=[];let sent;
  const c=vm.createContext({document:{getElementById:id=>elements[id]},esc,liName:n=>n,liDisplayQty:li=>Number(li.quantity)||1,toast(){},alert:m=>alerts.push(m),showDetail(){},api:async(action,args)=>{sent=args.body;return{inventory_status:'review',issues:[{message:'Needs supplier review'}]};}});
  loadFeedback(c,tech);vm.runInContext(segment(tech,'function fmtUsd(','// ── Photos'),c);
  c.mountTechLineItems({li_rev:2,line_items:[{name:'Custom catalog item',quantity:2,line_total:50,material_type:'flat',material_owner:'company'}]},'job');
  await elements.liSave.onclick();assert.equal(sent.items[0].material_type,'flat');assert.equal(sent.items[0].material_owner,'company');assert.match(alerts[0],/Needs supplier review/);
});
test('office line save preserves material identity and shows stock review',async()=>{
  const wrap={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null},elements={bkLineItems:wrap,bkLiTotal:{},bkLiAdd:{},bkLiDiscount:{},bkLiSave:{}},alerts=[];let sent;
  const c=vm.createContext({document:{getElementById:id=>elements[id]},esc,current:{slug:'demo'},liIsDefaultType:()=>false,liIsDismountAnswer:()=>false,liCleanLabel:n=>n,tvSizeIndex:()=>-1,TV_SIZES:[],money:String,confirm:()=>true,toast(){},alert:m=>alerts.push(m),refreshCurrent(){},api:async(action,args)=>{sent=args.body;return{inventory_status:'review',review_reason:'legacy_job_requires_review',li_rev:3};}});
  loadFeedback(c,admin);vm.runInContext(segment(admin,'function mountLineItemsEditor(','// ── Change / add the card'),c);
  c.mountLineItemsEditor({id:'job',li_rev:2,line_items:[{label:'Custom catalog item',quantity:2,price:25,line_total:50,material_type:'tilting',material_owner:'company'}]});
  await elements.bkLiSave.onclick();assert.equal(sent.items[0].material_type,'tilting');assert.equal(sent.items[0].material_owner,'company');assert.match(alerts[0],/legacy job requires review/);
});
