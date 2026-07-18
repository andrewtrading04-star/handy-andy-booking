// api/_lib/tech-late.js
// Tech lateness alerts. Driven by a scheduled trigger (GitHub Actions, every
// ~10 min) that hits
//   GET /api/migrate?action=tech_late_check&secret=CRON_SECRET
//
// Rule: a booking is "late" once its scheduled_at is 30+ minutes in the past
// and the tech still hasn't tapped "On my way" in the tech app (status is
// still pending/confirmed/assigned — on_the_way_at never got stamped). When
// that happens:
//   * the tech gets a text telling them they're late and staff was notified
//   * the business's admin (Heather for Handy Andy, Joey for Dom's) gets a
//     text naming the tech, the customer, and how late they are
//   * the owner (OWNER_PHONE_NUMBER, if set — same env var the review-alert
//     flow already uses) gets a copy of the staff text too
//
// Idempotent — a booking is alerted at most once. State is stored in the
// existing bookings.metadata JSONB (metadata.late_alert_sent_at), so no schema
// migration is required, same pattern as api/_lib/reminders.js.
import { serviceClient } from './supabase.js';
import { sendSMSResult } from './sms.js';

const MIN = 60 * 1000;
const LATE_AFTER_MS = 30 * MIN;     // how late before it counts
const LOOKBACK_MS = 24 * 60 * MIN;  // ignore anything older than this (stuck/stale data), not a fresh no-show

// Statuses that mean the tech hasn't headed to THIS job yet.
const NOT_EN_ROUTE_STATUSES = ['pending', 'confirmed', 'assigned'];

// business slug -> admin escalation phone env var.
const STAFF_PHONE_ENV = {
  'handy-andy': 'HEATHER_PHONE_NUMBER',
  'doms': 'JOEY_PHONE_NUMBER',
};

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'Tech';
}

// Run one lateness-check pass. Returns a summary; never throws on a single bad row.
//   opts.dryRun — find + report eligible bookings without sending anything.
export async function checkLateTechs(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const lateThresholdISO = new Date(now - LATE_AFTER_MS).toISOString();
  const lookbackISO = new Date(now - LOOKBACK_MS).toISOString();

  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug, name');
  if (bizErr) throw new Error(`businesses query failed: ${bizErr.message}`);
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));

  // Candidate bookings: scheduled 30min-24h in the past, tech still hasn't
  // started heading there, not yet alerted.
  const { data: rows, error } = await db
    .from('bookings')
    .select('id, business_id, status, scheduled_at, metadata, technician_id, technician:technicians!technician_id(name, phone), customer:customers(name)')
    .in('status', NOT_EN_ROUTE_STATUSES)
    .not('technician_id', 'is', null)
    .lte('scheduled_at', lateThresholdISO)
    .gte('scheduled_at', lookbackISO);
  if (error) throw new Error(`bookings query failed: ${error.message}`);

  const summary = { checked: 0, alerted: 0, skipped: 0, errors: 0, details: [] };

  for (const b of rows || []) {
    summary.checked++;
    const meta = b.metadata || {};
    const biz = bizById.get(b.business_id) || {};
    const slug = biz.slug;
    const techPhone = b.technician?.phone;
    const techName = b.technician?.name;
    const customerName = b.customer?.name || 'the customer';

    let skip = null;
    if (meta.late_alert_sent_at) skip = 'already alerted';
    else if (!techPhone) skip = 'no technician phone on file';
    else if (!slug || !STAFF_PHONE_ENV[slug]) skip = `no staff escalation number configured for business (${slug || b.business_id})`;

    if (skip) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip });
      continue;
    }

    const staffPhone = process.env[STAFF_PHONE_ENV[slug]];
    if (!staffPhone) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: `${STAFF_PHONE_ENV[slug]} env var not set` });
      continue;
    }

    const techMsg = `You are LATE! You haven't hit "On my way" for your next job. Staff has been notified.`;
    const staffMsg = `Attention: ${firstName(techName)} is 30 minutes late to the job with ${customerName}.`;
    // Owner CC is optional — if OWNER_PHONE_NUMBER isn't set, or happens to be
    // the same number as the staff phone (avoid double-texting one phone).
    const ownerPhone = process.env.OWNER_PHONE_NUMBER;
    const ccOwner = ownerPhone && ownerPhone !== staffPhone;

    if (dryRun) {
      summary.alerted++;
      summary.details.push({ id: b.id, wouldAlert: { tech: techPhone, staff: staffPhone, owner: ccOwner ? ownerPhone : null }, slug });
      continue;
    }

    try {
      const techResult = await sendSMSResult(techPhone, techMsg);
      const staffResult = await sendSMSResult(staffPhone, staffMsg);
      const ownerResult = ccOwner ? await sendSMSResult(ownerPhone, staffMsg) : null;
      // Only mark the booking alerted once the tech text actually went out —
      // otherwise a provider hiccup would silently mean this booking NEVER
      // gets a late alert again (see reminders.js, which applies the same
      // check-before-marking rule to its own send). The staff/owner texts
      // failing alone doesn't block marking — the tech has still been told
      // they're late, which is the half that matters most if only one can go out.
      if (!techResult.ok) {
        summary.errors++;
        summary.details.push({ id: b.id, error: `tech SMS not sent: ${techResult.error || techResult.skipped}` });
        console.error(`[tech-late] tech SMS failed for booking ${b.id}, will retry next pass:`, techResult.error || techResult.skipped);
        continue;
      }
      if (!staffResult.ok) {
        console.warn(`[tech-late] staff SMS failed for booking ${b.id}:`, staffResult.error || staffResult.skipped);
      }
      if (ownerResult && !ownerResult.ok) {
        console.warn(`[tech-late] owner SMS failed for booking ${b.id}:`, ownerResult.error || ownerResult.skipped);
      }
      const newMeta = { ...meta, late_alert_sent_at: new Date(now).toISOString() };
      const { error: upErr } = await db.from('bookings').update({ metadata: newMeta }).eq('id', b.id);
      if (upErr) console.warn(`[tech-late] alerted but failed to mark booking ${b.id}:`, upErr.message);
      summary.alerted++;
      summary.details.push({ id: b.id, alerted: { tech: techName, staffEnv: STAFF_PHONE_ENV[slug], staffSent: staffResult.ok, ownerSent: ownerResult ? ownerResult.ok : null }, slug });
      console.log(`[tech-late] late alert sent — tech=${techName} booking=${b.id} slug=${slug}`);
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: b.id, error: e.message });
      console.error(`[tech-late] error on booking ${b.id}:`, e.message);
    }
  }

  console.log(`[tech-late] pass complete: checked=${summary.checked} alerted=${summary.alerted} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun}`);
  return summary;
}
