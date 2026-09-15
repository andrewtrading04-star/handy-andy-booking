import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {numberVolumes} from '../api/_lib/number-volume.js';
import {ensureReviewToken,mintReviewToken,reviewRequestSms} from '../api/_lib/review-token.js';
import {signToken,verifyToken} from '../api/_lib/auth.js';
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let _callsData='),html.indexOf('// Scroll to (and briefly ring)'));
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function context(extra={}){return vm.createContext({console,Date,Set,Promise,API:'/api/admin',token:'test',role:'owner',current:{slug:'handy-andy'},esc:escape,fmtDateTime:s=>s,fmtPhone:s=>s,money:s=>String(s),_callFocusId:null,...extra});}
test('admin scripts parse',()=>{for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(m[1].trim())new vm.Script(m[1]);});

test('API deadline covers a stalled response body',async()=>{
 let aborted=false;
 const ctx=context({URL,location:{origin:'https://example.com'},setTimeout,clearTimeout,AbortController,
  fetch:async(url,{signal})=>({ok:true,status:200,json:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;const e=new Error('aborted');e.name='AbortError';reject(e);}))})});
 vm.runInContext(html.slice(html.indexOf('async function api('),html.indexOf('// Finances hits its own')),ctx);
 await assert.rejects(ctx.api('review_calls',{timeoutMs:10}),/timed out/);assert.equal(aborted,true);
});

test('review queue shows retry after failure and paints on successful retry',async()=>{
 let retry,painted=false,fail=true;
 const view={innerHTML:'',querySelector:()=>({addEventListener:(event,fn)=>retry=fn})};
 const ctx=context({_callPageRequest:0,_rcFolder:'to_call',_rcDays:1,document:{getElementById:()=>view},onScreen:()=>true,
  api:async()=>{if(fail)throw Error('Timed out');return {calls:[]};},paintReviewCalls:()=>painted=true});
 vm.runInContext(html.slice(html.indexOf('async function renderReviewCalls(){'),html.indexOf('function paintReviewCalls(){')),ctx);
 await ctx.renderReviewCalls();assert.match(view.innerHTML,/Try again/);assert.equal(typeof retry,'function');
 fail=false;await retry();assert.equal(painted,true);
});

test('number volume paginates, normalizes phones and keeps unknown answers separate',async()=>{
 let pages=0;const rows=Array.from({length:1001},(_,id)=>({id,grasshopper_number:id%2?'(303) 555-0101':'+13035550101',occurred_at:'2026-09-14T12:00:00Z',answered:id===1000?null:id%2===0}));
 const db={from:()=>{const q={select:()=>q,eq:()=>q,gte:()=>q,lt:()=>q,order:()=>q,range:async(a,b)=>{pages++;return {data:rows.slice(a,b+1)};}};return q;}};
 const result=await numberVolumes(db,[{phone:'+13035550101'},{phone:'5125550102'}],new Date('2026-09-15T18:00:00Z'));
 const v=result['+13035550101'];assert.equal(pages,2);assert.equal(v.total,1001);assert.equal(v.missed,500);assert.equal(v.unknown,1);assert.equal(v.answer_rate,50);assert.equal(v.average_daily,11.1);assert.equal(v.daily.length,90);assert.equal(v.to,'2026-09-14');assert.equal(result['5125550102'].answer_rate,null);
});
test('number directory searches formatted phones, businesses, people and status',()=>{
 const ctx=context({friendlyForward:p=>p==='staff'?'Heather':'Voicemail only'});
 vm.runInContext(html.slice(html.indexOf('function prettyNum('),html.indexOf('async function renderCallAnalytics(){')),ctx);
 assert.equal(ctx.prettyNum('+13035550101'),'(303) 555-0101');
 vm.runInContext(html.slice(html.indexOf('function matchingNumbers('),html.indexOf('function paintNumberDirectory(')),ctx);
 const rows=[{phone:'+13035550101',business_name:'Handy Andy',market:'Denver',active:true,forward_to:'staff'},{phone:'+15125550102',business_name:'Austin Mounting',active:false}];
 assert.equal(ctx.matchingNumbers(rows,'(303) 555','all').length,1);
 assert.equal(ctx.matchingNumbers(rows,'Heather','active')[0].phone,rows[0].phone);
 assert.equal(ctx.matchingNumbers(rows,'Austin','active').length,0);
 assert.equal(ctx.matchingNumbers(rows,'','retired')[0].phone,rows[1].phone);
 assert.equal(ctx.matchingNumbers(rows,'not found','all').length,0);
});
test('late report responses cannot replace another tab',async()=>{
 for(const [start,end,screen] of [['async function renderCallAnalytics(){','// ── Calls (Grasshopper','callanalytics'],['async function renderCallAudit(){','// Every tracking number across','callaudit'],['async function renderReviewCallReport(){','async function renderReviewCalls(){','reviewcalls']]){
  let resolve;const view={innerHTML:''};const ctx=context({_callPageRequest:0,_caRange:'7',_cauRange:'7',_rcrDays:7,CAU_RANGES:{'7':{days:7,offset:0}},document:{getElementById:()=>view},onScreen:()=>false,api:()=>new Promise(r=>resolve=r)});
  vm.runInContext(html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start))),ctx);
  const run=vm.runInContext(start.replace('async function ','').replace('{',''),ctx);
  view.innerHTML='Another tab';resolve({});await run;assert.equal(view.innerHTML,'Another tab',screen);
 }
});
test('hub navigation survives child repaint and stays separate from content',async()=>{
 const view={innerHTML:'',classList:{toggle(){}},closest:()=>null},navigation={hidden:true,innerHTML:'',querySelectorAll:()=>[],querySelector:()=>({addEventListener(){}})};
 const tabs=[{id:'log',label:'Incoming Calls',show:()=>true,render:async()=>{view.innerHTML='Calls loaded';}},{id:'review',label:'Review Calls',show:()=>true,render:async()=>{view.innerHTML='Reviews loaded';}}];
 const ctx=vm.createContext({document:{getElementById:id=>id==='view'?view:navigation},CALL_TABS:tabs,ANALYTICS_TABS:[],callHubTab:'log',_hubScrollKey:'',esc:escape,hubBackBar:()=>'<button id="hubBack">Back</button>'});
 vm.runInContext(html.slice(html.indexOf('async function renderHub('),html.indexOf('async function renderCallHub(')),ctx);
 await ctx.renderHub(tabs,'log',()=>{});const before=navigation.innerHTML;
 view.innerHTML='Calls repainted after filter or poll';assert.equal(navigation.innerHTML,before);assert.equal(navigation.hidden,false);assert.match(before,/Incoming Calls/);
 await ctx.renderHub(tabs,'review',()=>{});assert.match(navigation.innerHTML,/aria-pressed="true" data-hub="review"/);
 assert.match(html,/<nav id="hubNavigation"[^>]*><\/nav><div id="view">/);
});
test('inbox escapes content and selects notification target',()=>{
 const ctx=context();vm.runInContext(source,ctx);
 ctx.rows=[{id:'a',customer:{name:'<img onerror=alert(1)>'},transcript:'<script>bad</script>',status:'new',answered:false,occurred_at:'2026-09-15T10:00:00Z'}, {id:'b',status:'resolved',answered:true,occurred_at:'2026-09-15T11:00:00Z'}];
 const markup=vm.runInContext('callInbox(rows)',ctx);assert.ok(markup.includes('&lt;img'));assert.ok(!markup.includes('<script>bad'));
 vm.runInContext("_callFocusId='b'",ctx);assert.match(vm.runInContext('callInbox(rows)',ctx),/data-callselect="b" aria-pressed="true"/);
 assert.equal(vm.runInContext('callOutcome({answered:false,called_back_at:"now"})',ctx),'Missed');
});
test('stale refresh and navigation cannot overwrite new results',async()=>{
 const pending=[];let screen=true;const view={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
 const ctx=context({document:{getElementById:()=>view},onScreen:()=>screen,api:()=>new Promise(r=>pending.push(r)),refreshCallsBadge:()=>{},toast:()=>{}});
 vm.runInContext(source,ctx);vm.runInContext('paintCalls=()=>{}',ctx);
 const a=vm.runInContext('renderCalls()',ctx),b=vm.runInContext('renderCalls()',ctx);
 pending[2]({open:[],tag:'new'});pending[3]({open:[]});await b;pending[0]({open:[],tag:'old'});pending[1]({open:[]});await a;
 assert.equal(vm.runInContext('_callsData.tag',ctx),'new');
 const c=vm.runInContext('renderCalls()',ctx);screen=false;pending[4]({open:[],tag:'away'});pending[5]({open:[]});await c;assert.equal(vm.runInContext('_callsData.tag',ctx),'new');
});
const dbMock=(error=null)=>({from:()=>({update:()=>({eq:async()=>({error})})})});
test('review tokens preserve legacy links, renew expired and wrong tokens',async()=>{
 const b={id:'a',review_token:signToken({booking_id:'a'},3600)};assert.equal(await ensureReviewToken(dbMock(),b),b.review_token);
 for(const token of [mintReviewToken('other'),signToken({kind:'admin',booking_id:'a'},3600),signToken({kind:'review',booking_id:'a'},-1)]){b.review_token=token;const t=verifyToken(await ensureReviewToken(dbMock(),b));assert.equal(t.booking_id,'a');assert.equal(t.kind,'review');}
});
test('failed renewal clears unusable link',async()=>{const b={id:'a',review_token:signToken({booking_id:'a'},-1)};assert.equal(await ensureReviewToken(dbMock({message:'test failure'}),b),null);assert.equal(b.review_token,null);});
test('review text uses brand domains',()=>{for(const [slug,name,domain] of [['handy-andy','Handy Andy','www.ihandyandy.com/r/'],['doms',"Dom’s TV Mounting",'www.domstvmounting.com/r/'],['precision','Precision','r.precisiontvinstallation.com/']])assert.ok(reviewRequestSms({slug,name,token:'a.b',clickUrl:'https://fallback.test'}).includes('https://'+domain+'a.b'));});
test('simultaneous callback claims admit one writer',async()=>{
 const admin=fs.readFileSync(new URL('../api/admin.js',import.meta.url),'utf8');const fn=admin.slice(admin.indexOf('async function callClaim('),admin.indexOf('// Mark a call called-back'));
 const row={id:'a',status:'new',claimed_by:null,claimed_at:null};let reads=0,release;const barrier=new Promise(r=>release=r);
 const db={from:()=>{let patch;const filters=[];const q={select:()=>q,eq:(k,v)=>(filters.push([k,v]),q),is:(k,v)=>(filters.push([k,v]),q),update:p=>(patch=p,q),single:async()=>{const snapshot={...row};if(++reads===2)release();await barrier;return {data:snapshot};},maybeSingle:async()=>{if(!filters.every(([k,v])=>row[k]===v))return {data:null};Object.assign(row,patch);return {data:{id:row.id}};}};return q;}};
 const ctx=vm.createContext({Date,claimIsHot:()=>false});vm.runInContext(fn,ctx);const response=()=>({status(code){this.code=code;return this;},json(body){this.body=body;return this;}});const a=response(),b=response();
 await Promise.all([ctx.callClaim({method:'POST'},a,db,{name:'Andrew'},{id:'a'}),ctx.callClaim({method:'POST'},b,db,{name:'Heather'},{id:'a'})]);assert.deepEqual([a.code,b.code].sort(),[200,409]);
});
