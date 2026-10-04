import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
function cut(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert(start>=0&&end>start,a);return html.slice(start,end);}
const engine=cut('const NB_QTY_KEYS =','const TAX_RATE =')+
  cut('function nbLiftingKind(label){','// The chosen second tech as')+
  cut('const CW_REQUIRED_GROUPS=', '// ── Saying the price out loud')+
  cut('function nbValidateTvCatalog(groups){','async function nbLoadTvOptionsUncached')+
  cut('function cwArticle(phrase){','// Where the caller heard about us.');
const clickSource=cut("document.getElementById('callWizBody').addEventListener('click', e=>{","document.getElementById('callWizBody').addEventListener('input', e=>{");
const plain=x=>JSON.parse(JSON.stringify(x));
function catalog(){
  const group=(key,options)=>({id:key,key,label:key,options:options.map(([id,label,price])=>({id,label,price}))});
  return [
    group('size',[['small','33"–59"',109],['medium','70"–85"',149],['large','86"–97"',179],['huge','98"+',229]]),
    group('bracket',[['own','I have my own bracket',0],['flat','Flat',45],['xl','85"–100" TV Flat Bracket',90]]),
    group('fireplace',[['no','TV NOT above a fireplace',0],['yes','TV above a fireplace',30]]),
    group('surface',[['dry','Drywall',0],['brick','Brick',35]]),
    group('wires',[['behind','Hide wires BEHIND the wall',75],['outside','Hide wires OUTSIDE the wall',25],['frame','OneConnect box install',350]]),
    group('lifting',[['under','TV under 70"',0],['help','70–85" — customer can help lift',0],['two','2 technicians',70],['big','85"+ (second technician required)',70]]),
    group('extras',[['sound','Soundbar installation',65],['other','Other',0],['labor','1 hour of Handyman Labor',85]]),
  ];
}
function setup(){
  const elements=new Map();let click;
  function element(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,style:{},addEventListener(event,fn){if(id==='callWizBody'&&event==='click')click=fn;}});return elements.get(id);}
  const c=vm.createContext({document:{getElementById:element},nbAreaName:'Denver',nbConvertLines:null,nbCustomItems:()=>[],nbCurrentMinimum:()=>139,
    api:async()=>({config:null}),esc:String,current:{slug:'doms'},callWiz:{_visible:true,service:'TV Mounting',step:'tvopts',optStep:0,extrasGate:null,wireOverlap:null,_wireOverlapKey:null},cwInvalidatePrice(){},renderCallWiz(){},money:n=>'$'+n});
  vm.runInContext(engine+clickSource,c);
  c.groups=catalog();vm.runInContext('nbOptionGroups=groups;nbMultiTvCfg={...NB_MULTI_TV_DEFAULTS};',c);
  function set(qty,frame=0){c.quantities=qty;c.frameCount=frame;vm.runInContext('Object.keys(nbQty).forEach(k=>delete nbQty[k]);Object.assign(nbQty,quantities);nbFrameTvQty.frame=frameCount;cwSyncTvCounts();',c);}
  function get(code){return vm.runInContext(code,c);}
  function tap(group,option,d=1){const button={disabled:false,dataset:{g:group,o:option,d:String(d)}};click({target:{closest:sel=>sel==='.nb-q-btn'?button:null}});}
  function frame(d=1){const button={disabled:false,dataset:{t:'frame',d:String(d)}};click({target:{closest:sel=>sel==='.nb-tv-q-btn'?button:null}});}
  function pick(id){c.nbHandleOptClick({target:{closest:sel=>sel==='.nb-opt[data-pick="1"]'?{dataset:{g:'lifting',o:id}}:null}});}
  function overlap(n){const button={disabled:false,dataset:{cwoverlap:String(n)}};click({target:{closest:sel=>sel==='[data-cwoverlap]'?button:null}});}
  return {c,set,get,tap,frame,pick,overlap,element};
}
const answered=(sizes={small:1})=>({size:sizes,fireplace:{no:Object.values(sizes).reduce((a,b)=>a+b,0)},surface:{dry:Object.values(sizes).reduce((a,b)=>a+b,0)}});

test('size steppers create the count, while Frame converts existing TVs',()=>{
  const h=setup();h.tap('size','small');h.tap('size','small');h.frame();
  assert.deepEqual(plain(h.get('nbFrameTvQty')),{regular:1,frame:1});
  assert.equal(h.c.nbTotalTvs(),2);assert.equal(h.c.nbGroupCount('size'),2);
  h.tap('size','small',-1);assert.equal(h.c.nbTotalTvs(),1);assert.equal(h.c.nbGroupCount('size'),1);
});

test('the real phone Size markup enables the first TV and additional TVs without lifting New Booking caps',()=>{
  const h=setup();
  const phoneSize=cut("} else if(card.g.key==='size'){", "} else if(card.g.key==='extras'");
  const render=()=>{
    h.c.card={g:h.get("nbOptionGroups.find(g=>g.key==='size')")};
    const markup=h.get('let optsHtml;'+phoneSize.slice(phoneSize.indexOf('{')+1)+';optsHtml;');
    return [...markup.matchAll(/<button[^>]*data-d="1"[^>]*>/g)];
  };
  h.c.blocked=null;
  const first=render();assert.equal(first.length,4);assert(first.every(m=>!m[0].includes(' disabled')));
  h.tap('size','small');
  // Re-evaluate in a function scope because real renders declare fresh locals.
  const second=h.get('(function(){let optsHtml,blocked;'+phoneSize.slice(phoneSize.indexOf('{')+1)+';return optsHtml;})()');
  assert([...second.matchAll(/<button[^>]*data-d="1"[^>]*>/g)].every(m=>!m[0].includes(' disabled')));
  const booking=h.c.nbGroupOptsHtml(h.c.card.g,true);
  assert([...booking.matchAll(/<button[^>]*data-d="1"[^>]*>/g)].every(m=>m[0].includes(' disabled')));
});

test('Frame is always asked between Size and Bracket, including when extras is skipped or absent',()=>{
  const h=setup();h.set(answered());h.c.callWiz.extrasGate='no';
  assert.deepEqual(Array.from(h.c.callWizCards(),h.c.cwOptionKey).slice(0,4),['size','frame','bracket','fireplace']);
  h.get("nbOptionGroups=nbOptionGroups.filter(g=>g.key!=='extras')");
  assert.equal(h.c.callWizCards().filter(x=>x.kind==='frame').length,1);
});

test('marking all TVs as Frame keeps the active Frame card and removes brackets',()=>{
  const h=setup();h.set({...answered(),bracket:{flat:1}});h.c.callWiz.optStep=1;h.frame();
  assert.equal(h.c.cwOptionKey(h.c.callWizCards()[h.c.callWiz.optStep]),'frame');
  assert(!h.c.callWizCards().some(c=>c.g?.key==='bracket'));assert.equal(h.c.nbGroupCount('bracket'),0);
});

test('adding and removing TV sizes keeps the Size card selected as the list changes',()=>{
  const h=setup();h.tap('size','medium');assert.equal(h.c.callWiz.optStep,0);
  h.tap('size','small');h.tap('size','medium',-1);assert.equal(h.c.callWiz.optStep,0);
  assert(!h.c.callWizCards().some(c=>c.g?.key==='lifting'));
});

test('every TV needs valid size, fireplace and wall answers',()=>{
  const h=setup();h.set({...answered({small:2}),surface:{dry:1}});
  assert.match(h.c.nbValidateTvMountingRequired(),/wall surface.*1 of 2/);
  h.tap('surface','dry');assert.equal(h.c.cwValidateTvAnswers(),null);
  h.get("nbQty.surface={unknown:2}");assert.match(h.c.nbValidateTvMountingRequired(),/0 of 2/);
});

test('lifting is required for large TVs and cannot be bypassed with a partial catalog',()=>{
  const h=setup();h.set(answered({medium:1}));
  assert.match(h.c.cwValidateTvAnswers(),/lifting/);
  const card=h.c.callWizCards().find(c=>c.g?.key==='lifting');assert.match(h.c.cwOptionProblem(card),/Choose the lifting/);
  h.pick('help');assert.equal(h.c.cwValidateTvAnswers(),null);
  h.get("nbOptionGroups=nbOptionGroups.filter(g=>g.key!=='lifting')");assert.match(h.c.cwValidateTvAnswers(),/lifting.*missing/);
});

test('mixed medium and huge TVs require the large-TV lifting selection',()=>{
  const h=setup();h.set({...answered({medium:1,huge:1}),lifting:{help:1}});
  const options=h.c.nbVisibleOptions(h.get("nbOptionGroups.find(g=>g.key==='lifting')"));
  assert.deepEqual(Array.from(options,o=>o.id),['big']);
  h.c.nbPruneInvisibleOptions();assert.equal(h.c.nbGroupCount('lifting'),0);
  h.pick('big');assert.equal(h.c.cwValidateTvAnswers(),null);assert.equal(h.c.nbSecondTechMode(),'mandatory');
  h.pick('help');assert.equal(h.get('nbQty.lifting.help||0'),0);assert.equal(h.get('nbQty.lifting.big'),1);
});

test('medium TVs keep both customer-help and two-technician options',()=>{
  const h=setup();h.set(answered({medium:1}));
  assert.deepEqual(Array.from(h.c.nbVisibleOptions(h.get("nbOptionGroups.find(g=>g.key==='lifting')")),o=>o.id),['help','two']);
});

test('standard and XL brackets are capped to compatible TV quantities',()=>{
  const h=setup();h.set(answered({small:2,huge:1}));
  h.tap('bracket','flat');h.tap('bracket','flat');h.tap('bracket','flat');
  assert.equal(h.get('nbQty.bracket.flat'),2);h.tap('bracket','xl');assert.equal(h.get('nbQty.bracket.xl'),1);
  h.tap('bracket','xl');assert.equal(h.c.nbGroupCount('bracket'),3);
});

test('changing a size tier prunes incompatible excess brackets',()=>{
  const h=setup();h.set({...answered({small:2,huge:1}),bracket:{flat:2,xl:1}});
  h.tap('size','small',-1);assert.equal(h.get('nbQty.bracket.flat'),1);assert.equal(h.get('nbQty.bracket.xl'),1);
  h.tap('size','small',-1);assert.equal(h.get('nbQty.bracket.flat||0'),0);assert.equal(h.get('nbQty.bracket.xl'),1);
});

test('OneConnect quantity is capped by Frame TVs and vanishes when Frame is removed',()=>{
  const h=setup();h.set(answered({small:3}),1);
  h.tap('wires','frame');h.tap('wires','frame');assert.equal(h.get('nbQty.wires.frame'),1);
  h.c.callWiz.optStep=1;h.frame(-1);assert.equal(h.get('nbQty.wires.frame||0'),0);
});

test('wire concealment updates after fireplace and wall changes',()=>{
  const h=setup();h.set({...answered({small:2}),wires:{behind:2}});
  h.tap('fireplace','no',-1);h.tap('fireplace','yes');assert.equal(h.get('nbQty.wires.behind'),1);
  h.tap('surface','dry',-1);h.tap('surface','brick');assert.equal(h.get('nbQty.wires.behind||0'),0);
  assert(!h.c.nbVisibleOptions(h.get("nbOptionGroups.find(g=>g.key==='wires')")).some(o=>o.id==='behind'));
});

const mixedWalls=(total,fireplace,hard)=>({size:{small:total},fireplace:{no:total-fireplace,yes:fireplace},surface:{dry:total-hard,brick:hard}});

test('ambiguous wall answers add an enabled overlap question immediately before Wires',()=>{
  const h=setup();h.set(mixedWalls(2,1,1));
  const cards=h.c.callWizCards(),index=cards.findIndex(c=>c.kind==='wire-overlap'),card=cards[index];
  assert.equal(cards[index-1].g.key,'surface');assert.equal(cards[index+1].g.key,'wires');
  h.c.callWiz.optStep=index;h.c.cwRefreshOptionProblem();
  assert.match(h.c.cwOptionProblem(card),/Choose how many/);assert.equal(h.element('cwOptNext').disabled,true);
  assert.match(h.c.callWizGroupScript(card),/above a fireplace.*brick/);
  const branch=cut("    if(card.kind==='wire-overlap'){", "    } else if(card.kind==='frame'){");
  const markup=h.get('(function(){let optsHtml;'+branch.slice(branch.indexOf('{')+1)+';return optsHtml;})()');
  const choices=[...markup.matchAll(/<button[^>]+data-cwoverlap="(\d+)"[^>]*>/g)];
  assert.deepEqual(choices.map(m=>Number(m[1])),[0,1]);assert(choices.every(m=>!m[0].includes(' disabled')));
  assert.equal(h.c.nbBehindWallMax(),0);assert.match(h.c.cwValidateTvAnswers(),/Choose how many/);
  h.overlap(1);h.c.cwRefreshOptionProblem();assert.equal(h.element('cwOptNext').disabled,false);
  assert.match(h.c.cwWireOverlapOptionsHtml(),/data-cwoverlap="1" aria-pressed="true"/);
});

test('one brick fireplace leaves the second drywall TV eligible, separate restricted TVs leave none',()=>{
  const h=setup();h.set(mixedWalls(2,1,1));h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.kind==='wire-overlap');
  h.overlap(1);assert.equal(h.c.nbBehindWallMax(),1);assert.equal(h.c.cwValidateTvAnswers(),null);
  const wires=h.get("nbOptionGroups.find(g=>g.key==='wires')"),enabled=h.c.nbGroupOptsHtml(wires,false);
  assert.match(enabled,/<button[^>]*class="nb-q-btn" data-g="wires" data-o="behind" data-d="1">/);
  h.tap('wires','behind');h.tap('wires','behind');assert.equal(h.get('nbQty.wires.behind'),1);
  h.overlap(0);assert.equal(h.c.nbBehindWallMax(),0);assert.equal(h.get('nbQty.wires.behind||0'),0);
  assert(!h.c.nbVisibleOptions(wires).some(o=>o.id==='behind'));assert.equal(h.c.cwValidateTvAnswers(),null);
});

test('all feasible multi-TV overlap counts yield the correct eligible route count without extra questions for certain answers',()=>{
  const h=setup();
  for(let total=1;total<=5;total++)for(let fireplace=0;fireplace<=total;fireplace++)for(let hard=0;hard<=total;hard++){
    h.set(mixedWalls(total,fireplace,hard));
    const min=Math.max(0,fireplace+hard-total),max=Math.min(fireplace,hard),state=h.c.cwWireOverlapState();
    assert.equal(state.required,min<max,`question for TVs=${total},fireplaces=${fireplace},hard walls=${hard}`);
    assert.equal(h.c.callWizCards().some(c=>c.kind==='wire-overlap'),min<max);
    if(min===max){assert.equal(state.answer,min);assert.equal(h.c.nbBehindWallMax(),total-fireplace-hard+min);continue;}
    h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.kind==='wire-overlap');
    for(let overlap=min;overlap<=max;overlap++){
      h.overlap(overlap);assert.equal(h.c.nbBehindWallMax(),total-fireplace-hard+overlap);
    }
  }
});

test('overlap choices exclude mathematically impossible counts and reject forced invalid answers',()=>{
  const h=setup();h.set(mixedWalls(3,2,2));h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.kind==='wire-overlap');
  const choices=[...h.c.cwWireOverlapOptionsHtml().matchAll(/data-cwoverlap="(\d+)"/g)].map(m=>Number(m[1]));
  assert.deepEqual(choices,[1,2]);h.overlap(0);h.overlap(3);h.overlap(1.5);
  assert.equal(h.c.cwWireOverlapState().answer,null);h.overlap(2);assert.equal(h.c.nbBehindWallMax(),1);
});

test('backward changes to size, Frame, fireplace or surface invalidate overlap and prune old wire selections',()=>{
  for(const change of [h=>h.tap('size','small'),h=>h.frame(),h=>h.tap('fireplace','yes',-1),h=>h.tap('surface','brick',-1)]){
    const h=setup();h.set(mixedWalls(2,1,1));h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.kind==='wire-overlap');h.overlap(1);
    h.tap('wires','behind');assert.equal(h.get('nbQty.wires.behind'),1);change(h);
    assert.equal(h.c.callWiz.wireOverlap,null);
    // Return to the exact prior selections. The old answer must not revive.
    h.set(mixedWalls(2,1,1));h.c.cwWireOverlapState();assert.equal(h.c.callWiz.wireOverlap,null);
    assert.match(h.c.cwValidateTvAnswers(),/Choose how many/);assert.equal(h.c.nbBehindWallMax(),0);
  }
});

test('the phone answer survives pause while New Booking keeps its existing wire limit',()=>{
  const h=setup();h.set(mixedWalls(2,1,1));h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.kind==='wire-overlap');h.overlap(1);
  assert.equal(h.c.nbBehindWallMax(),1);h.c.callWiz._visible=false;assert.equal(h.c.nbBehindWallMax(),0);
  assert.equal(h.c.callWiz.wireOverlap,1);h.c.callWiz._visible=true;assert.equal(h.c.nbBehindWallMax(),1);
});

test('the overlap prompt uses every selected non-drywall label and is absent without an available behind-wall service',()=>{
  const h=setup();h.get("nbOptionGroups.find(g=>g.key==='surface').options.push({id:'outdoor',label:'Outdoor / Stucco',price:50})");
  h.set({...mixedWalls(3,1,2),surface:{dry:1,brick:1,outdoor:1}});
  const card=h.c.callWizCards().find(c=>c.kind==='wire-overlap');assert.match(h.c.callWizGroupScript(card),/brick or outdoor \/ stucco/);
  h.get("nbOptionGroups.find(g=>g.key==='wires').options=nbOptionGroups.find(g=>g.key==='wires').options.filter(o=>o.id!=='behind')");
  assert(!h.c.callWizCards().some(c=>c.kind==='wire-overlap'));assert.equal(h.c.cwValidateTvAnswers(),null);
});

test('Other add-ons need a description and valid positive price; typed corrections enable Continue',()=>{
  const h=setup();h.set({...answered(),extras:{other:1}});
  h.c.callWiz.optStep=h.c.callWizCards().findIndex(c=>c.g?.key==='extras');
  assert.match(h.c.cwValidateTvAnswers(),/Describe/);
  h.get("nbOptionNotes.other='Run HDMI';nbOptionPrices.other='bad'");assert.match(h.c.cwValidateTvAnswers(),/price/);
  h.c.cwRefreshOptionProblem();assert.equal(h.element('cwOptNext').disabled,true);
  h.get("nbOptionPrices.other='$125.50'");h.c.cwRefreshOptionProblem();
  assert.equal(h.c.cwValidateTvAnswers(),null);assert.equal(h.element('cwOptNext').disabled,false);
});

test('catalog selections preserve exact money, quantities and descriptions without duplicated quantity text',()=>{
  const h=setup();h.set({...answered({small:2}),extras:{other:1}},1);
  h.get("nbOptionNotes.other='Run HDMI';nbOptionPrices.other='125.50'");
  const lines=plain(h.c.nbCollectSelections());
  assert.equal(lines.find(l=>l.option_id==='small').quantity,2);
  assert.equal(lines.find(l=>l.option_id==='small').label,'size: 33"–59"');
  assert.equal(lines.find(l=>l.option_id==='other').price,125.5);
  assert.equal(lines.find(l=>l.option_id==='other').label,'extras: Other: Run HDMI');
  assert.equal(lines.reduce((s,l)=>s+l.price*l.quantity,0),373.5);
  assert.match(h.c.cwJobSummary(),/1 TV, 1 Frame TV, and a run hdmi/);
});

test('minimum top-up and default multi-TV discounts match collected lines',()=>{
  const h=setup();h.set(answered());let lines=plain(h.c.nbCollectSelections());
  assert.equal(lines.find(l=>l.label==='Service minimum').price,30);
  assert.equal(lines.reduce((s,l)=>s+l.price*l.quantity,0),139);
  h.set(answered({small:3}));lines=plain(h.c.nbCollectSelections());
  assert.equal(lines.find(l=>l.label==='Multi-TV discount').price,-30);
  assert.equal(lines.find(l=>l.label.startsWith('Multi-TV price')).price,-20);
  assert.equal(lines.reduce((s,l)=>s+l.price*l.quantity,0),277);
  h.element('nbTravelFee').value='65';assert.equal(h.c.nbMultiTvFeeDiscount(),39);
});

test('Austin prices use the same amounts in row rendering and selections',()=>{
  const h=setup();h.c.nbAreaName='Austin';h.set({...answered(),bracket:{flat:1}});
  assert.equal(h.c.nbCollectSelections().find(l=>l.option_id==='flat').price,35);
  assert.match(h.c.nbGroupOptsHtml(h.get("nbOptionGroups.find(g=>g.key==='bracket')"),true),/\+\$35/);
});

test('optional bracket, wire and extras choices can remain empty without blocking a small-TV job',()=>{
  const h=setup();h.set(answered());assert.equal(h.c.cwValidateTvAnswers(),null);
  for(const key of ['bracket','wires','extras'])assert.equal(h.c.cwOptionProblem(h.c.callWizCards().find(c=>c.g?.key===key)),null);
});

test('spoken job summary includes OneConnect and lifting and normalizes XL bracket size punctuation',()=>{
  const h=setup();h.set({...answered({huge:2}),bracket:{xl:1},wires:{frame:1},lifting:{big:1}},1);
  const summary=h.c.cwJobSummary();
  assert.match(summary,/1 flat bracket/);assert.doesNotMatch(summary,/85|100/);
  assert.match(summary,/1 OneConnect box installation/);assert.match(summary,/lifting assistance/);
  h.set({...answered({medium:1}),lifting:{help:1}});
  assert.match(h.c.cwJobSummary(),/customer helping with lifting/);
});

test('every offered source, coupon and manual discount speaks its amount as before tax',()=>{
  for(const fractional of [false,true])for(const [name,startMarker] of [
    ['source',"    if(rung==='source'){"],['coupon',"    if(rung==='coupon'){"],['manual','    const committed=(Number(callWiz.discManual)||0)>0;'],
  ]){
    const start=html.indexOf(startMarker),end=html.indexOf(name==='coupon'?'      // Yes or no first.':'body.innerHTML=',start);
    assert(start>=0&&end>start);
    const c=vm.createContext({rung:name,callWiz:{discSource:'Google',discCoupon:{code:'SAVE',amount:10},discManual:10},CW_SOURCE_DISCOUNT:10,
      econState:'ready',spend:{max:40,remaining:10,eff:{source:10,coupon:10}},room:10,delta:10,cents:fractional,
      spokenTotal:'TWO EVEN',cwMoneyCents:()=>'$200.25',cwCloseTotal:()=>200.25,callWizScript:s=>s});
    // Keep the generated head within the actual branch's lexical scope.
    const branch=html.slice(start,end)+'return head;'+(name==='manual'?'':'}');
    const money=html.match(/^function cwRoundMoney\(value\).*$/m)[0]+'\n'+html.match(/^function cwNonnegativeMoney\(value\).*$/m)[0];
    const head=vm.runInContext(money+'\nfunction readHead(){'+branch+'}readHead()',c);
    assert.match(head,/before tax/i,`${name}, fractional=${fractional}`);
  }
});
