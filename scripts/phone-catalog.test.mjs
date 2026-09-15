import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
function cut(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert(a>=0 && b>a,`Source boundary: ${start}`);
  return html.slice(a,b);
}
const helpers=cut('const nbServicesCache=new Map();','// Bumped on every modal open')+
  cut('const nbTvOptionsCache=new Map();','// ── Calendar date + slot picker');
const healthy=()=>[
  {key:'size',options:[{id:'size-1',label:'33"–59"',price:109}]},
  {key:'bracket',options:[{id:'bracket-1',label:'Own bracket',price:0}]},
  {key:'fireplace',options:[{id:'fireplace-1',label:'No fireplace',price:0}]},
  {key:'surface',options:[{id:'surface-1',label:'Drywall',price:0}]},
];
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(api,extra={}){
  const c=vm.createContext({api,setTimeout,clearTimeout,current:{slug:'doms'},CW_REQUIRED_GROUPS:new Set(['size','fireplace','surface']),...extra});
  vm.runInContext(helpers,c);
  return c;
}

test('phone services finish while the shared New Booking roster is still loading',async()=>{
  const roster=deferred(),calls=[];
  const c=harness(async(action)=>{
    calls.push(action);
    if(action==='services') return {services:[{id:'tv',category:'TV Mounting'}]};
    if(action==='technicians') return roster.promise;
    return {groups:healthy()};
  });
  const booking=c.nbEnsureDataCached('doms');
  const svc=await c.nbEnsureServicesCached('doms');
  await c.nbLoadTvOptions(svc.services[0].id,'doms');
  assert.deepEqual(calls,['services','technicians','service_options']);
  roster.resolve({technicians:[{id:'t1'}]});
  const all=await booking;
  assert.equal(all.svc.services[0].id,'tv');
  assert.equal(all.tech.technicians[0].id,'t1');
});

test('roster failure cannot poison the independently cached services response',async()=>{
  const calls=[];
  const c=harness(async(action)=>{
    calls.push(action);
    if(action==='technicians') throw Error('Roster unavailable');
    return {services:[{id:'tv'}]};
  });
  await assert.rejects(c.nbEnsureDataCached('doms'),/Roster unavailable/);
  assert.equal((await c.nbEnsureServicesCached('doms')).services[0].id,'tv');
  assert.equal(calls.filter(x=>x==='services').length,1);
});

test('services requests deduplicate, expire after 60 seconds and remain business-specific',async()=>{
  let now=0;const calls=[];
  const c=harness(async(action,{params})=>{calls.push(params.business);return {services:[{id:params.business}]};},{Date:{now:()=>now}});
  await Promise.all([c.nbEnsureServicesCached('doms'),c.nbEnsureServicesCached('doms')]);
  now=59999;await c.nbEnsureServicesCached('doms');
  await c.nbEnsureServicesCached('handy-andy');
  now=60000;await c.nbEnsureServicesCached('doms');
  assert.deepEqual(calls,['doms','handy-andy','doms']);
});

test('failed or malformed services responses can be retried',async()=>{
  for(const bad of [Error('503'),{}]){
    let attempts=0;
    const c=harness(async()=>{if(++attempts===1){if(bad instanceof Error)throw bad;return bad;}return {services:[{id:'tv'}]};});
    await assert.rejects(c.nbEnsureServicesCached('doms'));
    assert.equal((await c.nbEnsureServicesCached('doms')).services[0].id,'tv');
    assert.equal(attempts,2);
  }
});

test('failed catalog loads reject and retry instead of becoming empty question lists',async()=>{
  let attempts=0;
  const c=harness(async()=>{if(++attempts===1)throw Error('503 options unavailable');return {groups:healthy()};});
  await assert.rejects(c.nbLoadTvOptions('tv','doms'),/503/);
  assert.equal((await c.nbLoadTvOptions('tv','doms')).length,4);
  assert.equal(attempts,2);
});

test('each missing or empty required TV group rejects and is evicted from cache',async()=>{
  for(const key of ['size','fireplace','surface'])for(const empty of [false,true]){
    let attempts=0;
    const partial=healthy().filter(g=>empty || g.key!==key);
    if(empty) partial.find(g=>g.key===key).options=[];
    const c=harness(async()=>({groups:++attempts===1?partial:healthy()}));
    await assert.rejects(c.nbLoadTvOptions('tv','doms'),new RegExp(key));
    await c.nbLoadTvOptions('tv','doms');
    assert.equal(attempts,2);
  }
});

test('optional extras, lifting and Frame groups are not required to load a valid catalog',async()=>{
  const c=harness(async()=>({groups:healthy()}));
  assert.equal((await c.nbLoadTvOptions('tv','doms')).length,4);
});

test('catalog cache deduplicates in-flight requests and gives each caller isolated arrays',async()=>{
  const pending=deferred();let attempts=0;
  const c=harness(async()=>{attempts++;return pending.promise;});
  const a=c.nbLoadTvOptions('tv','doms'),b=c.nbLoadTvOptions('tv','doms');
  pending.resolve({groups:healthy()});
  const [first,second]=await Promise.all([a,b]);
  first[0].options[0].price=999;first.push({key:'new'});
  assert.equal(second[0].options[0].price,109);assert.equal(second.length,4);
  assert.equal(attempts,1);
});

test('catalog expiry starts on successful completion, shares slow loads and refreshes later calls',async()=>{
  let now=0,attempts=0;const first=deferred();
  const c=harness(async()=>{attempts++;return attempts===1?first.promise:{groups:healthy().map(g=>({...g,options:g.options.map(o=>({...o,price:o.price+1}))}))};},{Date:{now:()=>now}});
  const initial=c.nbLoadTvOptions('tv','doms');now=90000;
  const pending=c.nbLoadTvOptions('tv','doms');assert.equal(attempts,1,'a slow pending load cannot expire into a duplicate');
  first.resolve({groups:healthy()});await Promise.all([initial,pending]);
  now=149999;assert.equal((await c.nbLoadTvOptions('tv','doms'))[0].options[0].price,109);assert.equal(attempts,1);
  now=150000;const [a,b]=await Promise.all([c.nbLoadTvOptions('tv','doms'),c.nbLoadTvOptions('tv','doms')]);
  assert.equal(attempts,2);assert.equal(a[0].options[0].price,110);a[0].options[0].price=999;assert.equal(b[0].options[0].price,110);
});

test('an expired catalog failure is never replaced by stale prices and the next attempt retries',async()=>{
  let now=0,attempts=0;
  const c=harness(async()=>{if(++attempts===2)throw Error('Updated catalog unavailable');return {groups:healthy()};},{Date:{now:()=>now}});
  await c.nbLoadTvOptions('tv','doms');now=60000;
  await assert.rejects(c.nbLoadTvOptions('tv','doms'),/Updated catalog unavailable/);
  await c.nbLoadTvOptions('tv','doms');assert.equal(attempts,3);
});

test('phone prefetch shares services and options with the visible card without fetching a roster or mutating UI data',async()=>{
  const services=deferred(),options=deferred(),calls=[];
  const c=harness((action,opts)=>{calls.push({action,...opts.params});return action==='services'?services.promise:options.promise;},
    {nbServices:[{id:'active-service'}],nbOptionGroups:[{key:'active-group'}]});
  const warming=c.cwWarmTvCatalog('doms');c.current={slug:'handy-andy'};
  const serviceForCard=c.nbEnsureServicesCached('doms');services.resolve({services:[{id:'tv',category:'TV Mounting'}]});
  const svc=await serviceForCard,visible=c.nbLoadTvOptions(svc.services[0].id,'doms');
  options.resolve({groups:healthy()});await Promise.all([warming,visible]);
  assert.deepEqual(calls.map(r=>r.action),['services','service_options']);assert(calls.every(r=>r.business==='doms'));
  assert.equal(c.nbServices[0].id,'active-service');assert.equal(c.nbOptionGroups[0].key,'active-group');
});

test('missing TV service and failed prefetch leave the visible card able to retry',async()=>{
  for(const failure of ['missing','options']){
    let services=0,options=0;
    const c=harness(async action=>{
      if(action==='services')return {services:++services===1&&failure==='missing'?[]:[{id:'tv',category:'TV Mounting'}]};
      if(++options===1&&failure==='options')throw Error('Options offline');return {groups:healthy()};
    });
    await assert.rejects(c.cwWarmTvCatalog('doms'));
    const svc=await c.nbEnsureServicesCached('doms');assert.equal((await c.nbLoadTvOptions(svc.services[0].id,'doms')).length,4);
    assert.equal(failure==='missing'?services:options,2);
  }
});

function manualTimers(){
  const pending=new Set();
  return {pending,setTimeout(fn,ms){const timer={fn,ms};pending.add(timer);return timer;},clearTimeout(timer){pending.delete(timer);},
    expire(){for(const timer of [...pending]){pending.delete(timer);timer.fn();}}};
}

test('phone service timeout detaches a stalled background request and late data cannot replace the retried cache',async()=>{
  const timers=manualTimers(),old=deferred(),calls=[];
  const c=harness((action,opts)=>{
    calls.push({action,...opts});
    if(action==='services')return calls.filter(r=>r.action==='services').length===1?old.promise:Promise.resolve({services:[{id:'fresh-tv',category:'TV Mounting'}]});
    return Promise.resolve({groups:healthy()});
  },timers);
  const background=c.nbEnsureServicesCached('doms'),phone=c.cwWarmTvCatalog('doms');
  assert.equal(calls.length,1);assert.equal(calls[0].timeoutMs,undefined,'ordinary New Booking keeps its default request limit');
  assert.deepEqual([...timers.pending].map(t=>t.ms),[12000]);
  const timedOut=assert.rejects(phone,/too long/);timers.expire();await timedOut;
  await c.cwWarmTvCatalog('doms');assert.equal(calls[1].timeoutMs,12000);assert.equal(calls[2].timeoutMs,12000);
  old.resolve({services:[{id:'old-tv',category:'TV Mounting'}]});await background;
  assert.equal((await c.nbEnsureServicesCached('doms')).services[0].id,'fresh-tv');
  assert.equal(calls.filter(r=>r.action==='technicians').length,0);assert.equal(timers.pending.size,0);
});

test('phone catalog timeout is retryable while an earlier New Booking load can finish for its original caller',async()=>{
  const timers=manualTimers(),old=deferred(),calls=[];
  const c=harness((action,opts)=>{
    calls.push({action,...opts});
    if(action==='services')return Promise.resolve({services:[{id:'tv',category:'TV Mounting'}]});
    if(calls.filter(r=>r.action==='service_options').length===1)return old.promise;
    const groups=healthy();groups[0].options[0].price=125;return Promise.resolve({groups});
  },timers);
  const booking=c.nbLoadTvOptions('tv','doms'),phone=c.cwWarmTvCatalog('doms');await tick();
  assert.deepEqual([...timers.pending].map(t=>t.ms),[12000]);
  const timedOut=assert.rejects(phone,/too long/);timers.expire();await timedOut;
  assert.equal((await c.cwWarmTvCatalog('doms'))[0].options[0].price,125);
  old.resolve({groups:healthy()});assert.equal((await booking)[0].options[0].price,109);
  assert.equal((await c.nbLoadTvOptions('tv','doms'))[0].options[0].price,125,'a late old result cannot restore stale shared prices');
  assert.equal(calls.filter(r=>r.action==='service_options').length,2);assert.equal(timers.pending.size,0);
});

test('every phone catalog request including legacy repairs has a 12-second limit',async()=>{
  const calls=[],legacy=healthy();legacy[0].options[0].label='70–84';let reads=0;
  const c=harness(async(action,opts)=>{
    calls.push({action,...opts});
    if(action==='services')return {services:[{id:'tv',category:'TV Mounting'}]};
    if(action==='service_options')return {groups:++reads===1?[healthy()[0]]:reads===2?legacy:healthy()};
    return {ok:true};
  });
  await c.cwWarmTvCatalog('handy-andy');
  assert.deepEqual(calls.map(r=>r.action),['services','service_options','seed_tv_options','service_options','relabel_tv_size','service_options']);
  assert(calls.every(r=>r.timeoutMs===12000));assert(calls.every(r=>r.params.business==='handy-andy'));
  const card=cut("  if(s==='tvopts'){", "    const cards=callWizCards();");
  assert.match(card,/nbEnsureServicesCached\(slug,\{timeoutMs:12000\}\)/);
  assert.match(card,/nbLoadTvOptions\(tvSvc\.id,slug,\{timeoutMs:12000\}\)/);
});

test('business changes cannot redirect catalog seed or relabel requests',async()=>{
  const pending=deferred(),calls=[];
  const legacy=healthy();legacy[0].options[0].label='70–84';
  const c=harness(async(action,opts)=>{
    calls.push({action,...opts.params});
    if(calls.length===1)return pending.promise;
    if(action==='service_options')return {groups:calls.length===3?legacy:healthy()};
    return {ok:true};
  },{current:{slug:'handy-andy'}});
  const load=c.nbLoadTvOptions('ha-tv','handy-andy');
  c.current={slug:'doms'};
  pending.resolve({groups:[healthy()[0]]});
  await load;
  assert.deepEqual(calls.map(x=>x.action),['service_options','seed_tv_options','service_options','relabel_tv_size','service_options']);
  assert(calls.every(x=>x.business==='handy-andy'));
  assert(calls.filter(x=>x.service_id).every(x=>x.service_id==='ha-tv'));
});

test('legacy seeding failures and incomplete seed results reject instead of caching',async()=>{
  for(const failure of ['post','partial']){
    let calls=0;
    const c=harness(async(action)=>{
      calls++;
      if(action==='seed_tv_options' && failure==='post')throw Error('Seed unavailable');
      return {groups:[healthy()[0]]};
    });
    await assert.rejects(c.nbLoadTvOptions('tv','handy-andy'));
    const firstCalls=calls;
    await assert.rejects(c.nbLoadTvOptions('tv','handy-andy'));
    assert.equal(calls,firstCalls*2);
  }
});

test('a valid legacy catalog still loads if the optional label repair fails',async()=>{
  const groups=healthy();groups[0].options[0].label='70–84';
  const c=harness(async(action)=>{if(action==='relabel_tv_size')throw Error('Label repair unavailable');return {groups};});
  assert.equal((await c.nbLoadTvOptions('tv','doms'))[0].options[0].label,'70–84');
});

test('a partial response after relabeling is rejected and retried',async()=>{
  let requests=0;
  const groups=healthy();groups[0].options[0].label='70–84';
  const c=harness(async(action)=>{
    if(action==='relabel_tv_size')return {ok:true};
    requests++;
    return {groups:requests===1?groups:requests===2?[healthy()[0]]:healthy()};
  });
  await assert.rejects(c.nbLoadTvOptions('tv','doms'),/incomplete/);
  assert.equal((await c.nbLoadTvOptions('tv','doms')).length,4);
  assert.equal(requests,3);
});

test('OneConnect still moves from extras to wires without losing optional choices',async()=>{
  const groups=healthy().concat([
    {key:'wires',options:[{id:'wire',label:'Inside wall',price:75}]},
    {key:'extras',options:[{id:'frame',label:'OneConnect box',price:350},{id:'sound',label:'Soundbar',price:50}]},
  ]);
  const c=harness(async()=>({groups}));
  const result=await c.nbLoadTvOptions('tv','doms');
  assert.deepEqual(Array.from(result.find(g=>g.key==='wires').options,o=>o.id),['wire','frame']);
  assert.deepEqual(Array.from(result.find(g=>g.key==='extras').options,o=>o.id),['sound']);
});

const nbCategorySource=cut('let nbCategoryRequest=0;','// Guaranteed Dismount Service step:');
function categoryHarness(api){
  const elements=new Map();let handler;
  function element(id){
    if(!elements.has(id))elements.set(id,{innerHTML:'',value:id==='nbCategory'?'TV Mounting':'',style:{},addEventListener:(event,fn)=>{if(id==='nbCategory')handler=fn;},dispatchEvent:()=>handler({target:element(id)})});
    return elements.get(id);
  }
  const c=harness(api,{document:{getElementById:element},Event:class{},nbModalSession:1,nbServices:[{id:'tv',category:'TV Mounting'}],nbOptionGroups:[],renderNbServices(){},resetNbSteps(){},nbPopulateTechs(){},updateNbTotal(){},renderNbSteps(){c.rendered=true;},esc:String});
  vm.runInContext(nbCategorySource,c);
  return {c,element,run:()=>handler({target:element('nbCategory')})};
}

test('New Booking TV options cannot update shared state after the phone takes over',async()=>{
  for(const fail of [false,true]){
    const pending=deferred();
    const {c,element,run}=categoryHarness(()=>pending.promise);
    const load=run();c.nbModalSession++;
    element('nbSteps').innerHTML='Phone is active';
    if(fail)pending.reject(Error('Network failed'));else pending.resolve({groups:healthy()});
    await load;
    assert.equal(c.nbOptionGroups.length,0);assert.equal(c.rendered,undefined);
    assert.equal(element('nbSteps').innerHTML,'Phone is active');
  }
});

test('New Booking shows a usable retry after catalog failure',async()=>{
  let attempts=0;
  const {c,element,run}=categoryHarness(async()=>{if(++attempts===1)throw Error('Options unavailable');return {groups:healthy()};});
  await run();assert.match(element('nbSteps').innerHTML,/Try again/);
  element('nbRetryTvOptions').onclick();await tick();
  assert.equal(c.rendered,true);assert.equal(c.nbOptionGroups.length,4);assert.equal(attempts,2);
});

test('New Booking service-load continuations respect session and business changes',async()=>{
  const start=html.lastIndexOf('  try{',html.indexOf('// Services + technicians change rarely;'));
  const end=html.indexOf('  // Pre-fill an existing customer',start);
  assert(start>=0 && end>start);
  const branch=html.slice(start,end);
  for(const changed of ['session','business'])for(const fail of [false,true]){
    const pending=deferred();let touched=false;
    const c=vm.createContext({nbModalSession:1,current:{slug:'doms'},nbEnsureDataCached:()=>pending.promise,document:{getElementById:()=>{touched=true;return {};}}});
    vm.runInContext('async function openLoad(){const myNbSession=nbModalSession, myNbBusiness=current.slug;const nbOpenStale=()=>myNbSession!==nbModalSession || current?.slug!==myNbBusiness;'+branch+'}',c);
    const load=c.openLoad();
    if(changed==='session')c.nbModalSession++;else c.current={slug:'handy-andy'};
    if(fail)pending.reject(Error('Services unavailable'));else pending.resolve({svc:{services:[]},tech:{technicians:[]}});
    await load;assert.equal(touched,false,`${changed}, failed=${fail}`);
  }
});
