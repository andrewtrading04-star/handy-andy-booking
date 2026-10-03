import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../api/admin.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
const start=source.indexOf('async function secretariesList(');
const end=source.indexOf('\n}\n',start);
assert.ok(start>=0&&end>start,'secretariesList function exists');
const fn=source.slice(start,end+3);
const names=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function setup(){
  const rows={
    businesses:[{id:'ha',slug:'handy-andy'},{id:'doms',slug:'doms'}],
    staff_users:[{name:'Heather',phone:'+17207223653'},{name:'Joey',phone:'+13032190118'}],
    staff_schedules:[
      {name:'Alex',day_of_week:1,phone:'+14055550101'},
      {name:'Alex',day_of_week:2,phone:'+14055550101'},
      {name:'Alex',day_of_week:3,phone:'+14055550101'},
      {name:'Joe',day_of_week:5,phone:'+14055550102'},
      {name:'Joe',day_of_week:6,phone:'+14055550102'},
      {name:'Joe',day_of_week:0,phone:'+14055550102'},
    ],
  };
  const db={from(table){
    const q={table}; const b={select(){return b;},in(){return b;},eq(){return b;}};
    b.then=(resolve,reject)=>Promise.resolve({data:rows[table]||[],error:null}).then(resolve,reject);
    return b;
  }};
  const ctx=vm.createContext({DOW_NAMES:names,SECRETARY_RATE:{'handy-andy':{daily:95,currency:'USD'},doms:{daily:2083,currency:'PHP'}},
    displayNameFor:slug=>slug==='handy-andy'?'Heather':'Joey',
    fetchSecretaryAvailability:async(_db,id)=>({pattern:[{day_of_week:1,is_available:id==='ha'}],exceptions:[]})});
  vm.runInContext(fn,ctx);
  return {db,ctx};
}
const response=()=>({status(code){this.code=code;return this;},json(body){this.body=JSON.parse(JSON.stringify(body));return this;}});

test('Joey can see everyone’s weekly status and phone without pay fields',async()=>{
  const {db,ctx}=setup(),res=response();
  await ctx.secretariesList({},res,db,{role:'secretary',name:'Joey'});
  assert.equal(res.code,200);
  assert.deepEqual(res.body.secretaries.map(s=>s.name),['Heather','Joey','Alex','Joe']);
  const alex=res.body.secretaries.find(s=>s.name==='Alex');
  assert.equal(alex.phone,'+14055550101');
  assert.deepEqual(alex.pattern.filter(x=>x.is_available).map(x=>x.day_of_week),[1,2,3]);
  for(const person of res.body.secretaries){ assert.equal('daily_rate' in person,false); assert.equal('currency' in person,false); }
});

test('owner keeps pay data and Heather is not granted the cross-secretary roster',async()=>{
  const {db,ctx}=setup(),ownerRes=response();
  await ctx.secretariesList({},ownerRes,db,{role:'owner',name:'Andrew'});
  assert.equal(ownerRes.code,200);
  assert.equal(ownerRes.body.secretaries.find(s=>s.name==='Heather').daily_rate,95);
  const {db:db2,ctx:ctx2}=setup(),heatherRes=response();
  await ctx2.secretariesList({},heatherRes,db2,{role:'secretary',name:'Heather'});
  assert.equal(heatherRes.code,403);
});
