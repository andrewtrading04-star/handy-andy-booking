// api/_lib/estimate-escalation.js
// Two-stage reminder ladder for estimates nobody has responded to yet. Driven
// by a scheduled trigger (GitHub Actions, every ~15 min) that hits
//   GET /api/migrate?action=estimate_escalation_check&secret=CRON_SECRET
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A new estimate already gets an immediate text to the business's secretary
// (Heather/Handy Andy, Joey/Dom's) the second it's submitted — see
// api/estimate.js's "Notifications" block. That's stage 0 and this file does
// not touch it. What was missing was a way to catch one that sat unanswered:
//
//   STAGE 1 — REMINDER, 1 hour after creation, secretary only.
//     A short nudge with no customer specifics (she already got those in the
//     stage-0 text) — just "you still have one open."
//
//   STAGE 2 — ESCALATE, 2.5 hours after creation, secretary + owner.
//     Only reached if still unanswered. Names the customer and service so
//     Andrew doesn't have to open the dashboard to know what's stuck.
//
// "Responded to" == left status 'new'. That covers every real stop condition
// for free, no extra logic needed:
//   - quoted            -> estimateSendSms/estimateSendEmail set 'contacted'
//   - declined ("can't fix") -> estimateDecline sets 'declined'
//   - customer self-approved -> estimateApprove sets 'scheduled'
//   - deleted                -> row is gone, query just won't see it
// The 7-day auto-archive (api/admin.js estimates()) also flips 'new' ->
// 'archived', which happens to additionally stop the ladder past that point,
// but 2.5 hours is always long gone well before then.
//
// ── Idempotency markers (estimates.escalated_1h_at / escalated_2_5h_at) ─────
// Plain one-shot timestamp columns (migration 0097) — null until sent, never
// re-sent once stamped, same convention as bookings.metadata.staff_late_
// notified_at in the tech-lateness flow. A transient SMS failure still stamps
// the column (matching tech-late.js's "one-shot regardless of delivery
// outcome" choice) rather than retry forever — a secretary who never got the
// stage-0 text either has a real phone problem or a missing env var, and
// retrying the reminder every 15 min for that doesn't fix either.
import { serviceClient } from './supabase.js';
import { sendSMSResult, toE164 } from './sms.js';

const MIN = 60 * 1000;

// ── The two knobs. Changing either is a one-line edit. ──────────────────────
const REMIND_AFTER_MS = 60 * MIN;        // stage 1: secretary-only nudge
const ESCALATE_AFTER_MS = 150 * MIN;     // stage 2 (2.5h): secretary + owner

const LOOKBACK_MS = 24 * 60 * MIN;       // ignore anything older than this (stale data, not a fresh miss)

// Same business -> secretary-phone-env mapping api/estimate.js and
// api/admin.js's secretaryPhoneFor() already use for estimate notifications.
const SECRETARY_PHONE_ENV = {
  'handy-andy': 'HANDY_ANDY_SECRETARY_PHONE',
  'mile-high': 'HANDY_ANDY_SECRETARY_PHONE',
  'austin': 'HANDY_ANDY_SECRETARY_PHONE',
  'precision': 'HANDY_ANDY_SECRETARY_PHONE',
  'doms': 'DOMS_SECRETARY_PHONE',
};

// Only these two run the ladder for now (owner's call — the micro-brands
// route through Heather already but weren't asked for by name).
const LADDER_BUSINESSES = new Set(['handy-andy', 'doms']);

function dashboardEstimateUrl(id) {
  const base = process.env.PUBLIC_DASHBOARD_URL || process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return `${base}/admin.html?estimate=${encodeURIComponent(id)}`;
}

// Run one pass. Returns a summary; never throws on a single bad row.
//   opts.dryRun — find + report what would happen without sending anything.
export async function checkEstimateEscalations(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const lookbackISO = new Date(now - LOOKBACK_MS).toISOString();

  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug');
  if (bizErr) throw new Error(`businesses query failed: ${bizErr.message}`);
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));
  const ladderBizIds = (bizRows || []).filter(b => LADDER_BUSINESSES.has(b.slug)).map(b => b.id);

  const summary = { checked: 0, reminded: 0, escalated: 0, skipped: 0, errors: 0, details: [] };
  if (!ladderBizIds.length) {
    console.warn('[estimate-escalation] no matching businesses found for handy-andy/doms — nothing to do');
    return summary;
  }

  const { data: rows, error } = await db
    .from('estimates')
    .select('id, business_id, customer_name, service_label, status, created_at, escalated_1h_at, escalated_2_5h_at')
    .eq('status', 'new')
    .in('business_id', ladderBizIds)
    .gte('created_at', lookbackISO);
  if (error) throw new Error(`estimates query failed: ${error.message}`);

  for (const est of rows || []) {
    summary.checked++;
    const biz = bizById.get(est.business_id) || {};
    const slug = biz.slug;

    const createdMs = Date.parse(est.created_at);
    if (!Number.isFinite(createdMs)) {
      summary.skipped++;
      summary.details.push({ id: est.id, skip: 'unparseable created_at' });
      continue;
    }
    const ageMs = now - createdMs;
    const remindDue = ageMs >= REMIND_AFTER_MS && !est.escalated_1h_at;
    const escalateDue = ageMs >= ESCALATE_AFTER_MS && !est.escalated_2_5h_at;

    if (!remindDue && !escalateDue) {
      summary.skipped++;
      summary.details.push({ id: est.id, skip: 'not due yet or already sent' });
      continue;
    }

    const secretaryEnv = slug ? SECRETARY_PHONE_ENV[slug] : null;
    const secretaryPhone = secretaryEnv ? process.env[secretaryEnv] : null;
    if (!secretaryPhone) {
      summary.skipped++;
      summary.details.push({ id: est.id, skip: `${secretaryEnv || 'no secretary phone env mapped'} not set` });
      continue;
    }

    const customerName = est.customer_name || 'a customer';
    const serviceLabel = est.service_label || null;
    const link = dashboardEstimateUrl(est.id);

    const remindMsg = `⏰ You have an estimate waiting over 1hr — check the dashboard: ${link}`;
    const escalateMsg = `🚨 Estimate from ${customerName}${serviceLabel ? ` (${serviceLabel})` : ''} STILL not answered after 2.5hrs. ${link}`;

    const ownerPhoneRaw = process.env.OWNER_PHONE_NUMBER;
    const ccOwner = !!ownerPhoneRaw && toE164(ownerPhoneRaw) !== toE164(secretaryPhone);

    if (dryRun) {
      summary.details.push({
        id: est.id, slug,
        wouldRemind: remindDue ? secretaryPhone : null,
        wouldEscalate: escalateDue ? { secretary: secretaryPhone, owner: ccOwner ? ownerPhoneRaw : null } : null,
      });
      if (remindDue) summary.reminded++;
      if (escalateDue) summary.escalated++;
      continue;
    }

    try {
      let remindSentThisPass = false;
      if (remindDue) {
        const r = await sendSMSResult(secretaryPhone, remindMsg);
        if (!r.ok) console.warn(`[estimate-escalation] 1h reminder SMS failed for estimate ${est.id}:`, r.error || r.skipped);
        remindSentThisPass = true; // one-shot regardless of delivery outcome, matching tech-late.js
      }

      let escalateSentThisPass = false;
      if (escalateDue) {
        const secResult = await sendSMSResult(secretaryPhone, escalateMsg);
        if (!secResult.ok) console.warn(`[estimate-escalation] 2.5h secretary SMS failed for estimate ${est.id}:`, secResult.error || secResult.skipped);
        if (ccOwner) {
          const ownerResult = await sendSMSResult(ownerPhoneRaw, escalateMsg);
          if (!ownerResult.ok) console.warn(`[estimate-escalation] 2.5h owner SMS failed for estimate ${est.id}:`, ownerResult.error || ownerResult.skipped);
        }
        escalateSentThisPass = true;
      }

      const update = {};
      if (remindSentThisPass) update.escalated_1h_at = nowISO;
      if (escalateSentThisPass) update.escalated_2_5h_at = nowISO;
      if (Object.keys(update).length) {
        const { error: upErr } = await db.from('estimates').update(update).eq('id', est.id);
        if (upErr) console.warn(`[estimate-escalation] sent but failed to mark estimate ${est.id}:`, upErr.message);
      }

      if (remindSentThisPass) summary.reminded++;
      if (escalateSentThisPass) summary.escalated++;
      summary.details.push({ id: est.id, slug, reminded: remindSentThisPass, escalated: escalateSentThisPass });
      console.log(`[estimate-escalation] estimate=${est.id} slug=${slug} reminded=${remindSentThisPass} escalated=${escalateSentThisPass}`);
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: est.id, error: e.message });
      console.error(`[estimate-escalation] error on estimate ${est.id}:`, e.message);
    }
  }

  console.log(`[estimate-escalation] pass complete: checked=${summary.checked} reminded=${summary.reminded} escalated=${summary.escalated} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun}`);
  return summary;
}
