import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { mayUseBusiness } from '../api/_lib/staff-access.js';
const src=fs.readFileSync('api/admin.js','utf8');
const fn=vm.runInNewContext('('+src.slice(src.indexOf('async function reviewCallLog('),src.indexOf('\nasync function reviews(',src.indexOf('async function reviewCallLog(')))+')',{
 mayUseBusiness, REVIEW_CALL_STATUSES:['promised_review','complaint','voicemail','do_not_contact'],displayNameFor:()=> 'Heather', RC_TZ:'America/Denver',sendReviewCallComplaintAlert:async()=>{},console
});
async function run(auth,body,bk){let saved,output;const db={from(){return {select(){return this},eq(){return this},maybeSingle:async()=>({data:bk}),update(p){saved=p;return {eq:async()=>({error:null})}}}}};const res={status(n){this.code=n;return this},json(data){output={code:this.code,data};return output}};await fn({method:'POST'},res,db,auth,body);return {output,saved};}
const heather={role:'secretary',scope:'handy-andy',name:'Heather'}, booking={id:'job',status:'completed',business:{slug:'handy-andy'}};
for(const status of ['promised_review','complaint','voicemail','do_not_contact']){
 const r=await run(heather,{id:'job',status,from_pipeline:true,notes:status==='complaint'?'Mount is not level':''},booking);
 assert.equal(r.output.code,200);assert.equal(r.saved.review_call_status,status);assert.equal(r.saved.review_call_by,'Heather');
}
assert.equal((await run(heather,{id:'job',status:'voicemail'},booking)).output.code,403);
assert.equal((await run(heather,{id:'job',status:'voicemail',from_pipeline:true},{...booking,business:{slug:'doms'}})).output.code,403);
assert.equal((await run(heather,{id:'job',status:'voicemail',from_pipeline:true},{...booking,status:'scheduled'})).output.code,400);
assert.equal((await run(heather,{id:'job',status:'complaint',from_pipeline:true,notes:''},booking)).output.code,400);
const html=fs.readFileSync('public/admin.html','utf8');
const helper=html.slice(html.indexOf('function plIsReviewCall('),html.indexOf('async function plSaveReviewOutcome('));
const context={_plReview:{},esc:String,RC_OUTCOMES:[{v:'great',label:'Went great, 5 stars'},{v:'issue',label:'Something went wrong'},{v:'noanswer',label:'No answer'},{v:'dnc',label:'Do not contact'}]};vm.createContext(context);vm.runInContext(helper,context);
const c={key:'card',stage:'completed',booking:{id:'job'}};
assert.match(context.plReviewOutcomeHtml(c),/Log review call/);
context._plReview.card={outcome:null};for(const o of context.RC_OUTCOMES)assert.ok(context.plReviewOutcomeHtml(c).includes(o.label));
assert.equal(context.plReviewOutcomeHtml({...c,view_only:true}),'');
assert.equal(context.plIsReviewCall({stage:'new'}),false);
console.log('Pipeline review outcomes: four statuses, Heather access, cross-brand denial, completed-job guard, complaint validation, and rendered choices passed.');
