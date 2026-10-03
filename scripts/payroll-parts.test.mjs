import test from 'node:test';
import assert from 'node:assert/strict';
import { makePartsPlan, savePartsCorrection, settlePartsAdjustment, partsCorrectionsFor, partsPaymentSnapshot, partsAdjustmentDetail } from '../api/_lib/payroll-parts.js';
import { computeJobPay } from '../api/_lib/payroll.js';
const preview={id:'job',source_week:'2026-09-20',job_date:'2026-09-25',customer_name:'Derek Chase',techs:[{id:'steve',name:'Steve',business_id:'ha',job_pay:300},{id:'kregg',name:'Kregg',business_id:'ha',job_pay:300}]};
const input={corrected_total:423,target_week:'2026-09-27',paid_totals:{steve:700,kregg:1346}};
const plan=()=>makePartsPlan(preview,input,'Andrew');
function memoryDb(){
  const state={bookings:[{id:'job',business_id:'ha',notes:'Keep this job note.',metadata:{existing:'kept'}}],tech_bonuses:[],booking_notes:[]};
  let failOnce=null;
  const db={state,failNextBonus(id){failOnce=id;},from(table){
    let op='read',payload,filters=[],single=false,week;
    const q={
      select(){return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},
      eq(k,v){filters.push(r=>k==='metadata'?JSON.stringify(r[k])===v:r[k]===v);return q;},
      is(k,v){filters.push(r=>r[k]===v);return q;},
      contains(k,v){filters.push(r=>v.payroll_parts?.techs?.every(t=>r.metadata?.payroll_parts?.techs?.some(x=>x.id===t.id)));return q;},
      or(s){week=s.match(/\.eq\.(\d{4}-\d{2}-\d{2})/)?.[1];return q;},
      update(p){op='update';payload=p;return q;},upsert(p){op='upsert';payload=p;return q;},
      then(resolve,reject){try{
        if(table==='tech_bonuses'&&payload?.id===failOnce){failOnce=null;return Promise.resolve({data:null,error:new Error('Simulated network interruption')}).then(resolve,reject);}
        const rows=state[table];
        let result=rows.filter(r=>filters.every(f=>f(r)));
        if(week) result=result.filter(r=>[r.metadata?.payroll_parts?.source_week,r.metadata?.payroll_parts?.target_week].includes(week));
        if(op==='upsert'){if(!rows.some(r=>r.id===payload.id)) rows.push(structuredClone(payload)); result=[];}
        if(op==='update') for(const r of result) Object.assign(r,structuredClone(payload));
        return Promise.resolve({data:structuredClone(single?(result[0]||null):result),error:null}).then(resolve,reject);
      }catch(e){return Promise.reject(e).then(resolve,reject);}}
    };return q;
  }};return db;
}
test('423 is exactly 211.50 each; preserve actual 1346 and 700 paid; subtract 88.50 each',()=>{
  const p=plan();
  assert.deepEqual(p.techs.map(t=>[t.name,t.corrected_job_pay,t.deduction,t.paid_week_total]),[['Steve',211.5,88.5,700],['Kregg',211.5,88.5,1346]]);
  assert.match(p.message,/Andrew purchased and paid for/);
  assert.match(p.message,/not a deduction from your labor pay or a penalty/);
  assert.equal(700-88.5,611.5);assert.equal(1346-88.5,1257.5);
});
test('reject unequal-cent splits, old payroll week and missing actual payment',()=>{
  assert.throws(()=>makePartsPlan(preview,{...input,corrected_total:423.01},'Andrew'));
  assert.throws(()=>makePartsPlan(preview,{...input,target_week:'2026-09-20'},'Andrew'));
  assert.throws(()=>makePartsPlan(preview,{...input,paid_totals:{}},'Andrew'));
});
test('partial failure stays hidden; retries create exactly two deductions and one note',async()=>{
  const db=memoryDb(),p=plan();db.failNextBonus(p.techs[1].adjustment_id);
  await assert.rejects(savePartsCorrection(db,structuredClone(db.state.bookings[0]),p),/interruption/);
  assert.equal(db.state.bookings[0].metadata.payroll_parts.status,'preparing');
  assert.deepEqual(await partsCorrectionsFor(db,'2026-09-27',{businessId:'ha'}),[]);
  assert.equal(computeJobPay({status:'completed',notes:db.state.bookings[0].notes,payment_status:'paid'},'Steve').pay,0);
  await savePartsCorrection(db,structuredClone(db.state.bookings[0]),p);
  const again=await savePartsCorrection(db,structuredClone(db.state.bookings[0]),p);
  assert.equal(again.already,true);assert.equal(db.state.tech_bonuses.length,2);assert.equal(db.state.booking_notes.length,1);
  assert.deepEqual(db.state.tech_bonuses.map(r=>r.amount),[-88.5,-88.5]);
  assert.match(db.state.bookings[0].notes,/Keep this job note/);
  for(const name of ['Steve','Kregg']) assert.equal(computeJobPay({status:'completed',notes:db.state.bookings[0].notes},name).pay,211.5);
  const historical=await partsCorrectionsFor(db,'2026-09-20');
  assert.equal(partsPaymentSnapshot(historical,'steve','2026-09-20').amount,700);
  assert.equal(partsPaymentSnapshot(historical,'kregg','2026-09-20').amount,1346);
  const target=await partsCorrectionsFor(db,'2026-09-27');
  assert.equal(partsAdjustmentDetail(target,db.state.tech_bonuses[0],'2026-09-27').source_booking_id,'job');
  assert.equal(partsAdjustmentDetail(target,db.state.tech_bonuses[0],'2026-10-04'),null);
});
test('settling is idempotent and leaves the deduction on its one original week',async()=>{
  const db=memoryDb(),p=plan();await savePartsCorrection(db,structuredClone(db.state.bookings[0]),p);
  await settlePartsAdjustment(db,structuredClone(db.state.bookings[0]),p.techs[0].adjustment_id);
  const timestamp=db.state.bookings[0].metadata.payroll_parts.techs[0].settled_at;
  assert.equal((await settlePartsAdjustment(db,structuredClone(db.state.bookings[0]),p.techs[0].adjustment_id)).already,true);
  assert.equal(db.state.bookings[0].metadata.payroll_parts.techs[0].settled_at,timestamp);
  assert.equal(db.state.tech_bonuses.length,2);assert.deepEqual(await partsCorrectionsFor(db,'2026-10-04'),[]);
});
test('do not overwrite concurrent job notes or change a saved payment snapshot',async()=>{
  const db=memoryDb(),stale=structuredClone(db.state.bookings[0]);db.state.bookings[0].notes='A concurrent note.';
  await assert.rejects(savePartsCorrection(db,stale,plan()),/changed/);
  assert.equal(db.state.bookings[0].notes,'A concurrent note.');assert.equal(db.state.tech_bonuses.length,0);
  await savePartsCorrection(db,structuredClone(db.state.bookings[0]),plan());
  const different=makePartsPlan(preview,{...input,paid_totals:{steve:701,kregg:1346}},'Andrew');
  await assert.rejects(savePartsCorrection(db,structuredClone(db.state.bookings[0]),different),/different payroll correction/);
});
