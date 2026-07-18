// api/_lib/tech-late.js
// Tech lateness alerts. Driven by a scheduled trigger (GitHub Actions, every
// ~10 min) that hits
//   GET /api/migrate?action=tech_late_check&secret=CRON_SECRET
//
// Rule: a booking is "late" once its scheduled_at is 30+ minutes in the past
// and nobody has tapped "On my way" in the tech app yet (bookings.on_the_way_at
// is still null — checked directly, NOT inferred from status, so a job that
// gets reopened/reset back to an earlier status after a tech genuinely already
// went en route is correctly left alone). When that happens:
//   * every assigned tech with a phone on file (primary, and secondary on a
//     two-person lift job) gets a text telling them they're late
//   * the business's admin (Heather for Handy Andy, Joey for Dom's) gets a
//     text naming the tech(s), the customer, and how late they actually are
//   * the owner (OWNER_PHONE_NUMBER, if set — same env var the review-alert
//     flow already uses) gets a copy of the staff text, unless it's the same
//     phone as staff (compared as real E.164 numbers, not raw env strings)
//
// Idempotent, but with TWO independent markers so a tech whose SMS keeps
// failing (bad number, opted out) doesn't cause staff/owner to be re-texted
// every single 10-minute pass forever:
//   * metadata.tech_late_notified_ids — tech ids successfully texted; a tech
//     NOT yet in this list is retried next pass (transient failures self-heal).
//   * metadata.staff_late_notified_at — set the first time staff/owner are
//     attempted at all, regardless of send outcome. One-shot, like the rest
//     of this codebase's notification flags — staff is told once, not spammed.
// Reassigning either tech on a booking (api/admin.js "assign" case, primary
// OR secondary) clears both markers AND stamps metadata.reassigned_at, which
// this file uses to give the newly-assigned tech(s) a full fresh 30-minute
// grace period instead of being instantly flagged late for a slot they just
// inherited. Rescheduling (api/admin.js "reschedule") clears both markers too
// (no grace stamp needed there — the new scheduled_at itself is the buffer).
// Reopening a completed job (api/admin.js "reopen") gets the same 30-minute
// grace via metadata.reopened_at, covering the case where an admin bypassed
// on_the_way_at entirely via a direct status override.
//
// The final metadata write re-reads the row immediately beforehand (rather
// than reusing the pass-start snapshot) and merges onto THAT, so a slow pass
// (multiple awaited SMS sends) can't clobber a metadata key some other part
// of the app (tech.js completing the job, admin.js reassigning it) wrote in
// the meantime.
import { serviceClient } from './supabase.js';
import { sendSMSResult, toE164 } from './sms.js';

const MIN = 60 * 1000;
const LATE_AFTER_MS = 30 * MIN;       // how late before it counts
const LOOKBACK_MS = 24 * 60 * MIN;    // ignore anything older than this (stuck/stale data), not a fresh no-show
const REASSIGN_GRACE_MS = 30 * MIN;   // a freshly (re)assigned tech gets this long before they can be flagged

// Statuses that mean nobody has finished the job or cancelled it — paired
// with the on_the_way_at IS NULL check below (belt-and-suspenders: a job
// reopened back into one of these statuses after a tech already went en
// route is still excluded via on_the_way_at, not just this list).
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
  const nowISO = new Date(now).toISOString();
  const lateThresholdISO = new Date(now - LATE_AFTER_MS).toISOString();
  const lookbackISO = new Date(now - LOOKBACK_MS).toISOString();

  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug, name');
  if (bizErr) throw new Error(`businesses query failed: ${bizErr.message}`);
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));

  // Candidate bookings: scheduled 30min-24h in the past, nobody has headed
  // there yet (on_the_way_at still null — checked directly so a reopened-but-
  // already-handled job is excluded even if its status got reset), and at
  // least one of primary/secondary tech is actually assigned.
  const { data: rows, error } = await db
    .from('bookings')
    .select(`id, business_id, status, scheduled_at, metadata, on_the_way_at,
      technician_id, secondary_technician_id,
      technician:technicians!technician_id(name, phone),
      secondary_technician:technicians!secondary_technician_id(name, phone),
      customer:customers(name)`)
    .in('status', NOT_EN_ROUTE_STATUSES)
    .is('on_the_way_at', null)
    .lte('scheduled_at', lateThresholdISO)
    .gte('scheduled_at', lookbackISO);
  if (error) throw new Error(`bookings query failed: ${error.message}`);

  const summary = { checked: 0, alerted: 0, skipped: 0, errors: 0, details: [] };

  for (const b of rows || []) {
    // No tech assigned at all (neither primary nor secondary) — this is an
    // unstaffed-job problem, not a lateness one; nothing to alert on here.
    if (!b.technician_id && !b.secondary_technician_id) continue;
    summary.checked++;
    const meta = b.metadata || {};
    const biz = bizById.get(b.business_id) || {};
    const slug = biz.slug;
    const customerName = b.customer?.name || 'the customer';

    // A newly (re)assigned tech gets a full 30-minute grace period from the
    // moment they were assigned — not instant lateness for a job that was
    // already overdue when it landed on them (see api/admin.js "assign").
    // A just-reopened job gets the same grace period: on_the_way_at (checked
    // in the query above) normally proves a punctual job can't false-positive
    // after reopen, but an admin can bypass that by setting status straight to
    // 'completed' via the generic "status" action without ever stamping
    // on_the_way_at — reopening that job would otherwise re-enter the
    // candidate set and fire an immediate false "You are LATE!" blast.
    const graceAnchor = meta.reassigned_at && meta.reopened_at
      ? (Date.parse(meta.reassigned_at) > Date.parse(meta.reopened_at) ? meta.reassigned_at : meta.reopened_at)
      : (meta.reassigned_at || meta.reopened_at);
    if (graceAnchor) {
      const anchorMs = Date.parse(graceAnchor);
      if (Number.isFinite(anchorMs) && (now - anchorMs) < REASSIGN_GRACE_MS) {
        summary.skipped++;
        summary.details.push({ id: b.id, skip: 'within reassignment/reopen grace period' });
        continue;
      }
    }

    let skip = null;
    if (!slug || !STAFF_PHONE_ENV[slug]) skip = `no staff escalation number configured for business (${slug || b.business_id})`;
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

    // Every assigned tech (primary + secondary, deduped) who has a phone on
    // file — each gets their own copy of the "you're late" text.
    const allAssignedNames = [];
    const techsWithPhone = [];
    if (b.technician) {
      allAssignedNames.push(firstName(b.technician.name));
      if (b.technician.phone) techsWithPhone.push({ id: String(b.technician_id), name: b.technician.name, phone: b.technician.phone });
    }
    if (b.secondary_technician && b.secondary_technician_id !== b.technician_id) {
      allAssignedNames.push(firstName(b.secondary_technician.name));
      if (b.secondary_technician.phone) techsWithPhone.push({ id: String(b.secondary_technician_id), name: b.secondary_technician.name, phone: b.secondary_technician.phone });
    }

    const notifiedTechIds = new Set((meta.tech_late_notified_ids || []).map(String));
    const pendingTechs = techsWithPhone.filter(t => !notifiedTechIds.has(t.id));
    const staffAlreadyDone = !!meta.staff_late_notified_at;

    // Nothing left to do for this booking at all — every reachable tech has
    // already been successfully texted, and staff already got their one text.
    if (staffAlreadyDone && !pendingTechs.length) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: 'already alerted' });
      continue;
    }
    // No tech has a phone on file, and staff already knows — nothing left.
    if (!techsWithPhone.length && staffAlreadyDone) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: 'no technician phone on file (staff already told)' });
      continue;
    }

    const schedMs = Date.parse(b.scheduled_at);
    // Never show less than the 30-minute rule itself, even if clocks drift a
    // little — this is meant to read as "actually how late," not a countdown.
    const lateMinutes = Number.isFinite(schedMs) ? Math.max(30, Math.round((now - schedMs) / MIN)) : 30;

    const namesJoined = allAssignedNames.length ? allAssignedNames.join(' and ') : 'The assigned tech';
    const missingPhoneNote = techsWithPhone.length < allAssignedNames.length ? ' (no phone on file for at least one — reach them directly)' : '';
    const techMsg = `You are LATE! You haven't hit "On my way" for your next job. Staff has been notified.`;
    const staffMsg = `Attention: ${namesJoined} ${allAssignedNames.length > 1 ? 'are' : 'is'} ${lateMinutes} minutes late to the job with ${customerName}.${missingPhoneNote}`;

    // Owner CC is optional — compare as real E.164 numbers (not raw env
    // strings) so the same phone stored in two different formats still
    // correctly de-dupes into a single text.
    const ownerPhoneRaw = process.env.OWNER_PHONE_NUMBER;
    const ccOwner = !!ownerPhoneRaw && toE164(ownerPhoneRaw) !== toE164(staffPhone);

    if (dryRun) {
      summary.alerted++;
      summary.details.push({
        id: b.id,
        wouldAlert: { techs: pendingTechs.map(t => t.phone), staff: staffAlreadyDone ? null : staffPhone, owner: (!staffAlreadyDone && ccOwner) ? ownerPhoneRaw : null },
        slug,
      });
      continue;
    }

    try {
      const newlyNotifiedIds = [];
      for (const t of pendingTechs) {
        const r = await sendSMSResult(t.phone, techMsg);
        if (r.ok) newlyNotifiedIds.push(t.id);
        else console.warn(`[tech-late] tech SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      let staffSentThisPass = false;
      if (!staffAlreadyDone) {
        const staffResult = await sendSMSResult(staffPhone, staffMsg);
        if (!staffResult.ok) console.warn(`[tech-late] staff SMS failed for booking ${b.id}:`, staffResult.error || staffResult.skipped);
        if (ccOwner) {
          const ownerResult = await sendSMSResult(ownerPhoneRaw, staffMsg);
          if (!ownerResult.ok) console.warn(`[tech-late] owner SMS failed for booking ${b.id}:`, ownerResult.error || ownerResult.skipped);
        }
        // One-shot regardless of delivery outcome — matches the rest of this
        // codebase's notification-flag convention (attempt once, don't retry
        // forever on a transient provider hiccup for a non-critical CC).
        staffSentThisPass = true;
      }

      if (newlyNotifiedIds.length || staffSentThisPass) {
        // Re-read fresh right before writing (not the pass-start snapshot) so
        // a metadata key written elsewhere during our awaited sends — e.g. the
        // tech completing the job, or an admin reassigning it — isn't clobbered.
        const { data: freshRow, error: reErr } = await db.from('bookings').select('metadata').eq('id', b.id).maybeSingle();
        const freshMeta = (!reErr && freshRow && freshRow.metadata) || meta;
        const mergedTechIds = Array.from(new Set([...(freshMeta.tech_late_notified_ids || []).map(String), ...newlyNotifiedIds]));
        const newMeta = { ...freshMeta, tech_late_notified_ids: mergedTechIds };
        if (staffSentThisPass) newMeta.staff_late_notified_at = nowISO;
        const { error: upErr } = await db.from('bookings').update({ metadata: newMeta }).eq('id', b.id);
        if (upErr) console.warn(`[tech-late] alerted but failed to mark booking ${b.id}:`, upErr.message);
      }

      summary.alerted++;
      summary.details.push({ id: b.id, alerted: { techsNotified: newlyNotifiedIds.length, staffSent: staffSentThisPass, staffEnv: STAFF_PHONE_ENV[slug] }, slug });
      console.log(`[tech-late] pass handled booking=${b.id} slug=${slug} techsNotified=${newlyNotifiedIds.length} staffSent=${staffSentThisPass}`);
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: b.id, error: e.message });
      console.error(`[tech-late] error on booking ${b.id}:`, e.message);
    }
  }

  console.log(`[tech-late] pass complete: checked=${summary.checked} alerted=${summary.alerted} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun}`);
  return summary;
}
