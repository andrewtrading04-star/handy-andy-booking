// api/_lib/paid-not-complete.js
// Catches a job the tech charged the customer for but never tapped "Complete"
// on — the money is collected, but the job never leaves the tech's active
// list and the office/payroll never see it as done. Driven by the same
// scheduled trigger as tech-late.js:
//   GET /api/migrate?action=paid_not_complete_check&secret=CRON_SECRET
// (added to the existing every-10-min tech_late_check cron in vercel.json).
//
// One text to the tech, one time per job. Idempotent via
// metadata.paid_not_complete_notified_at, same pattern as tech-late.js's
// otw_nudge_sent_ids — a job that gets marked complete drops out of the
// candidate query on its own; nothing is ever queued that needs un-queuing.
import { serviceClient } from './supabase.js';
import { sendSMSResult } from './sms.js';

const MIN = 60 * 1000;
// Give the tech a few minutes to tap Complete right after charging before
// texting — most jobs finish within a couple minutes of payment.
const WAIT_AFTER_PAID_MS = 15 * MIN;
const LOOKBACK_MS = 24 * 60 * MIN;   // ignore anything older than this (stale data)

const OPEN_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress'];

export async function checkPaidNotComplete(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const cutoffISO = new Date(now - WAIT_AFTER_PAID_MS).toISOString();
  const lookbackISO = new Date(now - LOOKBACK_MS).toISOString();

  const { data: rows, error } = await db
    .from('bookings')
    .select(`id, status, paid_at, price, metadata,
      technician_id, secondary_technician_id,
      technician:technicians!technician_id(name, phone),
      secondary_technician:technicians!secondary_technician_id(name, phone),
      customer:customers(name)`)
    .in('status', OPEN_STATUSES)
    .eq('payment_status', 'paid')
    .not('paid_at', 'is', null)
    .lte('paid_at', cutoffISO)
    .gte('paid_at', lookbackISO);
  if (error) throw new Error(`bookings query failed: ${error.message}`);

  const summary = { checked: 0, notified: 0, skipped: 0, errors: 0, details: [] };

  for (const b of (rows || [])) {
    summary.checked++;
    const meta = b.metadata || {};
    if (meta.paid_not_complete_notified_at) { summary.skipped++; continue; }

    // Whoever took the payment is the one who needs the nudge -- usually the
    // lead tech, but a helper can be the one holding the card reader too, so
    // text both assigned techs rather than guessing which one it was.
    const techs = [b.technician, b.secondary_technician].filter(t => t && t.phone);
    if (!techs.length) { summary.skipped++; continue; }

    const stamp = new Date().toISOString();
    if (dryRun) {
      summary.details.push({ id: b.id, customer: b.customer?.name, techs: techs.map(t => t.name) });
      continue;
    }

    let anySent = false;
    for (const t of techs) {
      const name = (t.name || '').trim().split(/\s+/)[0] || 'Hey';
      const msg = `${name}, this job is marked paid but not Complete yet${b.customer?.name ? ` (${b.customer.name})` : ''}. Open the tech app and tap Complete to close it out.`;
      const r = await sendSMSResult(t.phone, msg);
      if (r.ok) anySent = true;
      else console.warn('[paid_not_complete] SMS failed', b.id, t.name, r.error || r.skipped);
    }

    // One-shot regardless of send outcome, same as tech-late.js's
    // staff_late_notified_at: a text failure is logged, not retried forever,
    // so a permanently-bad number can't spam the cron log every 10 minutes.
    const { data: fresh } = await db.from('bookings').select('metadata').eq('id', b.id).maybeSingle();
    const mergedMeta = { ...(fresh?.metadata || meta), paid_not_complete_notified_at: stamp };
    const { error: updErr } = await db.from('bookings').update({ metadata: mergedMeta }).eq('id', b.id);
    if (updErr) { summary.errors++; console.error('[paid_not_complete] metadata write failed', b.id, updErr.message); continue; }

    if (anySent) summary.notified++; else summary.errors++;
  }

  return summary;
}
