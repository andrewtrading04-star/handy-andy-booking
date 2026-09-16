import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { signToken, verifyToken } from '../api/_lib/auth.js';
import { compactReviewToken, expandReviewCode } from '../api/_lib/review-code.js';
import { reviewRequestSms } from '../api/_lib/review-token.js';

const booking_id = '2fa1333c-6072-4260-9c41-668599382e17';
test('compact codes preserve booking and expiry, including legacy review claims', () => {
  for (const payload of [{kind:'review',booking_id},{booking_id}]) {
    const token = signToken(payload, 3600);
    const code = compactReviewToken(token);
    assert.equal(code.length, 43);
    const decoded = verifyToken(expandReviewCode(code));
    assert.equal(decoded.booking_id, booking_id);
    assert.equal(decoded.kind, 'review');
    assert.equal(decoded.exp, verifyToken(token).exp);
    assert.equal(expandReviewCode(token), token);
  }
});
test('tampering, wrong secret, malformed codes and expired codes fail closed', () => {
  const code = compactReviewToken(signToken({kind:'review',booking_id}, 10));
  for (let i=0; i<code.length; i++) assert.equal(expandReviewCode(code.slice(0,i)+(code[i]==='A'?'B':'A')+code.slice(i+1)), null);
  for (const invalid of ['', 'demo', code+'a', code.slice(1), null]) assert.equal(expandReviewCode(invalid), null);
  const old = process.env.SESSION_SECRET;
  try { process.env.SESSION_SECRET='different-test-secret'; assert.equal(expandReviewCode(code),null); }
  finally { if(old===undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET=old; }
  const now = Date.now;
  try { Date.now=()=>now()+11000; assert.equal(expandReviewCode(code),null); }
  finally { Date.now=now; }
});
test('non-review credentials cannot be converted into review access', () => {
  const token=signToken({kind:'admin',booking_id},3600);
  assert.equal(compactReviewToken(token),token);
});
test('review texts use compact codes without exposing a business name', () => {
  const token=signToken({kind:'review',booking_id},3600);
  for (const slug of ['handy-andy','doms','precision','austin','mile-high']) {
    const sms=reviewRequestSms({slug,name:'Handy Andy TV Mounting',token});
    assert.match(sms,/^How did we do\? You can leave your technician a review here:\n\nhttps:\/\//);
    assert.ok(!sms.includes('Handy Andy TV Mounting'));
    assert.ok(!sms.includes("Dom's"));
    assert.ok(!sms.includes(token));
    const url=sms.match(/https:\/\/\S+/)[0];
    const code=new URL(url).pathname.split('/').pop();
    assert.equal(verifyToken(expandReviewCode(code)).booking_id,booking_id);
  }
});
test('click handler resolves compact links and records original booking/channel', async () => {
  const source=fs.readFileSync(new URL('../api/book.js',import.meta.url),'utf8');
  const start=source.indexOf("const REVIEW_CLICK_FALLBACK_URL");
  const end=source.indexOf('// After creating the booking',start);
  const token=signToken({kind:'review',booking_id},3600);
  for(const input of [token,compactReviewToken(token),'invalid']) {
    const tracked=[];
    const db={from:()=>({update:patch=>({eq:(key,id)=>({is:async()=>{tracked.push({patch,id});return {};}})})})};
    const ctx=vm.createContext({Buffer,Date,process:{env:{PUBLIC_URL:'https://booking.example'}},verifyToken,expandReviewCode,serviceClient:()=>db});
    vm.runInContext(source.slice(start,end),ctx);
    const res={redirect:(status,url)=>({status,url})};
    const result=await ctx.serveReviewClick({query:{token:input,ch:'sms'}},res);
    assert.equal(result.status,302);
    if(input==='invalid'){assert.equal(tracked.length,0);assert.equal(result.url,'https://www.ihandyandy.com/');}
    else {assert.equal(tracked[0].id,booking_id);assert.ok(tracked[0].patch.review_sms_clicked_at);assert.equal(verifyToken(new URL(result.url).searchParams.get('token')).booking_id,booking_id);}
  }
});
