import { createHash } from 'node:crypto';

export const partsMoney = n => Math.round(Number(n) * 100) / 100;
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function payrollSunday(day) {
  const date = new Date(day + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) fail('Invalid payroll week.');
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}
export function partsRecordId(jobId, techId, kind) {
  const hex = createHash('sha256').update(`payroll-parts-v1:${jobId}:${techId}:${kind}`).digest('hex').slice(0, 32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
}
export function makePartsPlan(preview, input, author) {
  const cents = Number(input.corrected_total) * 100;
  if (!Number.isFinite(cents) || Math.abs(cents - Math.round(cents)) > 0.00001 || cents < 0 || Math.round(cents) % 2) fail('Enter a total that can be split equally to the cent.');
  const targetWeek = String(input.target_week || '');
  if (payrollSunday(targetWeek) !== targetWeek || targetWeek <= preview.source_week) fail('Choose a Sunday after the original pay period.');
  if (preview.techs.length !== 2) fail('This correction requires two different assigned technicians.');
  const each = partsMoney(cents / 200);
  const techs = preview.techs.map(t => {
    const paid = Number(input.paid_totals?.[t.id]);
    if (!Number.isFinite(paid) || paid < 0 || Math.abs(paid * 100 - Math.round(paid * 100)) > 0.00001) fail(`Enter the amount already paid to ${t.name}.`);
    const deduction = partsMoney(t.job_pay - each);
    if (deduction <= 0) fail(`The corrected pay must be less than ${t.name}'s original job pay.`);
    return { id:t.id, name:t.name, business_id:t.business_id, paid_week_total:partsMoney(paid), original_job_pay:t.job_pay, corrected_job_pay:each, deduction, adjustment_id:partsRecordId(preview.id,t.id,'deduction'), settled_at:null };
  });
  const date = preview.job_date;
  const message = `Parts reimbursement correction — ${preview.customer_name}, ${date}. Your previous payroll included $${techs[0].deduction.toFixed(2)} for parts that Andrew purchased and paid for. That amount is being deducted once from the payroll week beginning ${targetWeek} to correct the reimbursement. This is not a deduction from your labor pay or a penalty.`;
  if (techs[0].deduction !== techs[1].deduction) fail('The two technicians have different original pay. Review this job before splitting the correction.');
  return { version:1, status:'preparing', source_week:preview.source_week, target_week:targetWeek, corrected_total:partsMoney(input.corrected_total), customer_name:preview.customer_name, job_date:date, techs, message, created_by:author, created_at:new Date().toISOString() };
}
async function checked(query) { const r = await query; if (r.error) throw r.error; return r.data; }
function unchangedBooking(q,booking) {
  q=booking.metadata==null?q.is('metadata',null):q.eq('metadata',JSON.stringify(booking.metadata));
  return booking.notes==null?q.is('notes',null):q.eq('notes',booking.notes);
}
export async function partsCorrectionsFor(db, week, { businessId, technicianId } = {}) {
  let q = db.from('bookings').select('id,metadata').or(`metadata->payroll_parts->>source_week.eq.${week},metadata->payroll_parts->>target_week.eq.${week}`);
  if (businessId) q = q.eq('business_id',businessId);
  if (technicianId) q = q.contains('metadata',{payroll_parts:{techs:[{id:technicianId}]}});
  const rows = await checked(q);
  return (rows || []).filter(b=>b.metadata?.payroll_parts?.status==='complete').map(b=>({booking_id:b.id,...b.metadata.payroll_parts}));
}
export function partsPaymentSnapshot(corrections, techId, week) {
  const rows = corrections.filter(c=>c.source_week===week && c.techs.some(t=>t.id===techId));
  if (!rows.length) return null;
  const totals = [...new Set(rows.map(c=>c.techs.find(t=>t.id===techId).paid_week_total))];
  if (totals.length!==1) throw new Error('Conflicting recorded payroll payments.');
  return { amount:totals[0], corrections:rows.map(c=>({booking_id:c.booking_id,customer_name:c.customer_name,deduction:c.techs.find(t=>t.id===techId).deduction,target_week:c.target_week})) };
}
export function partsAdjustmentDetail(corrections, row, week) {
  for (const c of corrections) {
    const t = c.techs.find(t=>t.adjustment_id===row.id && t.id===row.technician_id);
    if (c.target_week===week && t) {
      if (partsMoney(row.amount)!==-t.deduction) throw new Error('Payroll correction amounts do not match.');
      return { source_booking_id:c.booking_id, adjustment_id:row.id, settled_at:t.settled_at, message:c.message };
    }
  }
  return null;
}
export async function savePartsCorrection(db, booking, plan) {
  const existing = booking.metadata?.payroll_parts;
  if (existing) {
    if (existing.corrected_total!==plan.corrected_total || existing.target_week!==plan.target_week || JSON.stringify(existing.techs.map(t=>[t.id,t.paid_week_total]))!==JSON.stringify(plan.techs.map(t=>[t.id,t.paid_week_total]))) fail('This job already has a different payroll correction.');
    if (existing.status==='complete') return { ...existing, already:true };
    plan=existing;
  } else {
    const oldMeta=booking.metadata;
    const meta={...(oldMeta||{}),payroll_parts:plan};
    let q=unchangedBooking(db.from('bookings').update({metadata:meta}).eq('id',booking.id),booking);
    const locked=await checked(q.select('id').maybeSingle());
    if (!locked) throw Object.assign(new Error('This job changed. Reload it before saving.'),{status:409});
    booking.metadata=meta;
  }
  // Fixed IDs make retries safe. Preparing records are hidden from payroll until
  // the final atomic booking update commits both the override and correction.
  for (const t of plan.techs) {
    const row={id:t.adjustment_id,business_id:t.business_id,technician_id:t.id,amount:-t.deduction,reason:`Parts reimbursement correction — ${plan.customer_name}, ${plan.job_date}`,message:plan.message,awarded_on:plan.target_week};
    await checked(db.from('tech_bonuses').upsert(row,{onConflict:'id',ignoreDuplicates:true}));
    const stored=await checked(db.from('tech_bonuses').select('amount,technician_id,awarded_on').eq('id',row.id).single());
    if (Number(stored.amount)!==row.amount || stored.technician_id!==row.technician_id || stored.awarded_on!==row.awarded_on) throw new Error('Payroll correction record does not match.');
  }
  await checked(db.from('booking_notes').upsert({id:partsRecordId(booking.id,'owner','note'),business_id:booking.business_id,booking_id:booking.id,author_kind:'owner',author_id:null,author_name:plan.created_by,body:`${plan.message}\nCorrected job pay: $${plan.corrected_total.toFixed(2)} total, $${plan.techs[0].corrected_job_pay.toFixed(2)} each. Previously paid for the week: ${plan.techs.map(t=>`${t.name} $${t.paid_week_total.toFixed(2)}`).join('; ')}.`},{onConflict:'id',ignoreDuplicates:true}));
  const notes = String(booking.notes||'').replace(/(?:^|\n)[^\n]*payroll\s*override[^\n]*/gi,'').trim();
  const complete={...plan,status:'complete'};
  const meta={...booking.metadata,payroll_parts:complete};
  const updated=await checked(unchangedBooking(db.from('bookings').update({notes:[notes,`Payroll override: $${plan.techs[0].corrected_job_pay.toFixed(2)}`,plan.message].filter(Boolean).join('\n'),metadata:meta}).eq('id',booking.id),booking).select('id').maybeSingle());
  if (!updated) throw Object.assign(new Error('The job changed before the correction finished. Retry to finish safely.'),{status:409});
  return complete;
}
export async function settlePartsAdjustment(db, booking, adjustmentId) {
  const correction=booking.metadata?.payroll_parts;
  const tech=correction?.techs?.find(t=>t.adjustment_id===adjustmentId);
  if (correction?.status!=='complete'||!tech) fail('Payroll adjustment not found.');
  if (tech.settled_at) return {already:true};
  const updated={...booking.metadata,payroll_parts:{...correction,techs:correction.techs.map(t=>t.id===tech.id?{...t,settled_at:new Date().toISOString()}:t)}};
  const row=await checked(db.from('bookings').update({metadata:updated}).eq('id',booking.id).eq('metadata',JSON.stringify(booking.metadata)).select('id').maybeSingle());
  if (!row) throw Object.assign(new Error('The adjustment changed. Refresh and try again.'),{status:409});
  return {ok:true};
}
