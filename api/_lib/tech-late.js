// api/_lib/tech-late.js
// Two-stage job punctuality flow. Driven by a scheduled trigger (GitHub
// Actions / Vercel cron, every ~10 min) that hits
//   GET /api/migrate?action=tech_late_check&secret=CRON_SECRET
//
// ── Why two stages ──────────────────────────────────────────────────────────
// The old single stage fired the tech's "You are LATE!" text and the office's
// escalation in the SAME pass, 30 minutes after the slot start. Jobs run in
// arrival windows, so 30 minutes in is usually fine, and the tech had no
// chance to put it right before staff were alarmed. Now:
//
//   STAGE 1 — NUDGE, 10 minutes BEFORE the scheduled start, tech only.
//     A short text with a one-tap link. Tapping it does exactly what the
//     "On My Way" button in the tech app does: stamps on_the_way_at and texts
//     the customer (api/book.js action=otw_send -> _lib/en-route.js). Nobody
//     in the office is told anything at this stage.
//
//   STAGE 2 — ESCALATE, 45 minutes AFTER the scheduled start, office + owner.
//     Only reached if on_the_way_at is STILL null. The message says the tech
//     was already nudged and didn't answer, so staff know it's a real problem
//     rather than a maybe.
//
// The reason stage 2 needs no "cancel" logic: the candidate query below already
// filters on on_the_way_at IS NULL. A tech who taps the link drops out of the
// result set on the next pass entirely by himself. Nothing is ever queued that
// would have to be un-queued.
//
// ── Idempotency markers (all in bookings.metadata) ──────────────────────────
//   * otw_nudge_sent_ids   — tech ids successfully nudged. A tech NOT in this
//                            list is retried next pass, so a transient SMS
//                            failure self-heals. Legacy tech_late_notified_ids
//                            (written by the pre-two-stage version) is read as
//                            an equivalent "already texted" marker so bookings
//                            in flight across the deploy aren't double-texted.
//   * otw_nudge_sent_at    — when stage 1 first went out, quoted to staff in
//                            the stage 2 message.
//   * staff_late_notified_at — one-shot, set the first time stage 2 is
//                            attempted at all regardless of send outcome.
//
// Reassigning either tech (api/admin.js "assign") clears these markers and
// stamps metadata.reassigned_at; reopening stamps reopened_at. Those grace
// stamps suppress ESCALATION only — a freshly assigned tech should still get
// his nudge immediately, since the whole point of the nudge is to tell him.
//
// The final metadata write re-reads the row immediately beforehand (rather than
// reusing the pass-start snapshot) and merges onto THAT, so a slow pass can't
// clobber a key some other part of the app wrote in the meantime.
import { serviceClient } from './supabase.js';
import { sendSMSResult, toE164 } from './sms.js';
import { signToken } from './auth.js';

const MIN = 60 * 1000;

// ── The three knobs. Changing any of these is a one-line edit. ──────────────
const NUDGE_LEAD_MS = 10 * MIN;       // stage 1 fires this long BEFORE the start
const ESCALATE_AFTER_MS = 45 * MIN;   // stage 2 fires this long AFTER the start
const NUDGE_LINK_TTL_S = 8 * 60 * 60; // one-tap link stays good this long

const LOOKBACK_MS = 24 * 60 * MIN;    // ignore anything older than this (stale data, not a fresh no-show)
const REASSIGN_GRACE_MS = 30 * MIN;   // a freshly (re)assigned tech can't be ESCALATED on for this long

// Statuses meaning nobody has finished or cancelled the job. Paired with the
// on_the_way_at IS NULL check below (belt and suspenders: a job reopened back
// into one of these after a tech genuinely went en route is still excluded by
// on_the_way_at, not just this list).
const NOT_EN_ROUTE_STATUSES = ['pending', 'confirmed', 'assigned'];

// business slug -> office escalation phone env var. Mile High jobs are always
// worked by a cross-hired Handy Andy tech (it has no techs of its own), so a
// late Mile High job escalates to Heather exactly like a Handy Andy one.
const STAFF_PHONE_ENV = {
  'handy-andy': 'HEATHER_PHONE_NUMBER',
  'mile-high': 'HEATHER_PHONE_NUMBER',
  'austin': 'HEATHER_PHONE_NUMBER',   // Heather covers the Austin brand too
  'precision': 'HEATHER_PHONE_NUMBER',// and the Houston Precision brand
  'doms': 'JOEY_PHONE_NUMBER',
  // Joey took the eight Austin/Houston lead-gen lines (2026-08-25). They were
  // absent here entirely, so a late job on one escalated to NOBODY: the loop
  // records "no office number configured for business" and moves on, which is
  // the quietest way for a customer to sit waiting on a tech who never came.
  // These brands have no techs of their own — the work is done by cross-hired
  // Handy Andy techs (Zach in Austin, Juan in Houston) — but the CUSTOMER is
  // Joey's to answer for, so the escalation is hers.
  'atxmountpros': 'JOEY_PHONE_NUMBER',
  'atxtvmount': 'JOEY_PHONE_NUMBER',
  'austinmountingpros': 'JOEY_PHONE_NUMBER',
  'austintvinstall': 'JOEY_PHONE_NUMBER',
  'houstonmounting': 'JOEY_PHONE_NUMBER',
  'houstontvinstallation': 'JOEY_PHONE_NUMBER',
  'htvmounting': 'JOEY_PHONE_NUMBER',
  'tvhanginghouston': 'JOEY_PHONE_NUMBER',
};

// Fallbacks for the vars above, so an UNSET one cannot silently turn a late-job
// escalation into nothing. Joey's is owner-confirmed (2026-08-25) and matches
// both staff_users.phone and her tracking-number routing. Heather's has no
// confirmed value here, so hers stays env-only rather than being guessed at.
const STAFF_PHONE_FALLBACK = { JOEY_PHONE_NUMBER: '3032190118' };

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'Tech';
}

function baseUrl() {
  return process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

// One batched Map(service_area_id -> timezone) so each job can be described in
// its OWN metro's clock (an Austin job is Central), not the server's.
async function areaTzMap(db, ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const { data } = await db.from('service_areas').select('id, timezone').in('id', uniq);
    return Object.fromEntries((data || []).map(r => [r.id, r.timezone]));
  } catch { return {}; }
}

function timeInTz(iso, tz) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: tz || 'America/Denver', hour: 'numeric', minute: '2-digit',
    });
  } catch { return null; }
}

// Run one pass. Returns a summary; never throws on a single bad row.
//   opts.dryRun — find + report what would happen without sending anything.
export async function checkLateTechs(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  // Upper bound reaches into the near future so stage 1 can fire BEFORE the
  // start. Cron granularity is ~10 min, so a job is nudged by whichever pass
  // first sees it inside the lead window.
  const horizonISO = new Date(now + NUDGE_LEAD_MS).toISOString();
  const lookbackISO = new Date(now - LOOKBACK_MS).toISOString();

  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug, name, timezone');
  if (bizErr) throw new Error(`businesses query failed: ${bizErr.message}`);
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));

  const { data: rows, error } = await db
    .from('bookings')
    .select(`id, business_id, status, scheduled_at, metadata, on_the_way_at, service_area_id,
      technician_id, secondary_technician_id,
      technician:technicians!technician_id(name, phone),
      secondary_technician:technicians!secondary_technician_id(name, phone),
      customer:customers(name)`)
    .in('status', NOT_EN_ROUTE_STATUSES)
    .is('on_the_way_at', null)
    .lte('scheduled_at', horizonISO)
    .gte('scheduled_at', lookbackISO);
  if (error) throw new Error(`bookings query failed: ${error.message}`);

  const tzById = await areaTzMap(db, (rows || []).map(r => r.service_area_id));

  const summary = { checked: 0, nudged: 0, escalated: 0, skipped: 0, errors: 0, details: [] };

  for (const b of rows || []) {
    // Neither tech assigned — that's an unstaffed-job problem, not a
    // punctuality one. Nothing to nudge and nobody to name.
    if (!b.technician_id && !b.secondary_technician_id) continue;
    summary.checked++;

    const meta = b.metadata || {};
    const biz = bizById.get(b.business_id) || {};
    const slug = biz.slug;
    const customerName = b.customer?.name || 'the customer';
    const tz = tzById[b.service_area_id] || biz.timezone || 'America/Denver';

    const schedMs = Date.parse(b.scheduled_at);
    if (!Number.isFinite(schedMs)) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: 'unparseable scheduled_at' });
      continue;
    }
    const msSinceStart = now - schedMs;
    const nudgeDue = msSinceStart >= -NUDGE_LEAD_MS;      // we're inside the 10-min run-up (or past it)
    const escalateDue = msSinceStart >= ESCALATE_AFTER_MS;

    // Every assigned tech (primary + secondary, deduped) with a phone on file.
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

    // Legacy key counts as "already texted" so a booking mid-flight across the
    // deploy doesn't get a second text under the new scheme.
    const alreadyNudged = new Set([
      ...(meta.otw_nudge_sent_ids || []).map(String),
      ...(meta.tech_late_notified_ids || []).map(String),
    ]);
    const pendingTechs = nudgeDue ? techsWithPhone.filter(t => !alreadyNudged.has(t.id)) : [];
    const staffAlreadyDone = !!meta.staff_late_notified_at;

    // Escalation is suppressed during the grace window after a reassignment or
    // reopen (the tech may have only just inherited this slot). The NUDGE is
    // deliberately NOT suppressed — that's the text telling him about it.
    let escalateBlockedBy = null;
    const graceAnchor = meta.reassigned_at && meta.reopened_at
      ? (Date.parse(meta.reassigned_at) > Date.parse(meta.reopened_at) ? meta.reassigned_at : meta.reopened_at)
      : (meta.reassigned_at || meta.reopened_at);
    if (graceAnchor) {
      const anchorMs = Date.parse(graceAnchor);
      if (Number.isFinite(anchorMs) && (now - anchorMs) < REASSIGN_GRACE_MS) {
        escalateBlockedBy = 'reassignment/reopen grace period';
      }
    }

    const staffPhoneEnv = slug ? STAFF_PHONE_ENV[slug] : null;
    const staffPhone = staffPhoneEnv
      ? (process.env[staffPhoneEnv] || STAFF_PHONE_FALLBACK[staffPhoneEnv] || null)
      : null;
    if (!escalateBlockedBy && !staffPhoneEnv) escalateBlockedBy = `no office number configured for business (${slug || b.business_id})`;
    if (!escalateBlockedBy && !staffPhone) escalateBlockedBy = `${staffPhoneEnv} env var not set`;

    const willEscalate = escalateDue && !staffAlreadyDone && !escalateBlockedBy;

    if (!pendingTechs.length && !willEscalate) {
      summary.skipped++;
      summary.details.push({
        id: b.id,
        skip: escalateDue
          ? (staffAlreadyDone ? 'already handled' : (escalateBlockedBy || 'nothing left to do'))
          : 'not due yet',
      });
      continue;
    }

    // Never show less than the rule itself, even if clocks drift a little.
    const lateMinutes = Math.max(Math.round(ESCALATE_AFTER_MS / MIN), Math.round(msSinceStart / MIN));
    const whenTxt = timeInTz(b.scheduled_at, tz);
    const namesJoined = allAssignedNames.length ? allAssignedNames.join(' and ') : 'The assigned tech';
    const missingPhoneNote = techsWithPhone.length < allAssignedNames.length
      ? ' (no phone on file for at least one, reach them directly)' : '';
    const nudgedAtTxt = timeInTz(meta.otw_nudge_sent_at, tz);
    const nudgeNote = nudgedAtTxt ? ` Texted at ${nudgedAtTxt} with no response.` : '';

    const staffMsg = `Attention: ${namesJoined} ${allAssignedNames.length > 1 ? 'are' : 'is'} ${lateMinutes} minutes late to the job with ${customerName}.${nudgeNote}${missingPhoneNote}`;

    const ownerPhoneRaw = process.env.OWNER_PHONE_NUMBER;
    const ccOwner = !!ownerPhoneRaw && !!staffPhone && toE164(ownerPhoneRaw) !== toE164(staffPhone);

    if (dryRun) {
      summary.details.push({
        id: b.id, slug,
        wouldNudge: pendingTechs.map(t => ({ phone: t.phone, name: t.name })),
        wouldEscalate: willEscalate ? { staff: staffPhone, owner: ccOwner ? ownerPhoneRaw : null, msg: staffMsg } : null,
      });
      if (pendingTechs.length) summary.nudged++;
      if (willEscalate) summary.escalated++;
      continue;
    }

    try {
      // ── Stage 1: nudge each tech who hasn't had one yet ────────────────────
      const newlyNudged = [];
      for (const t of pendingTechs) {
        // Per-tech token: identifies the booking AND who tapped, so a two-tech
        // job attributes the en-route text to whoever actually responded.
        const token = signToken({ kind: 'otw_quick', booking_id: b.id, tech_id: t.id }, NUDGE_LINK_TTL_S);
        const link = `${baseUrl()}/otw.html?token=${encodeURIComponent(token)}`;
        const msg = whenTxt
          ? `Next job: ${customerName} at ${whenTxt}. Tap to let them know you're on the way: ${link}`
          : `Next job: ${customerName}. Tap to let them know you're on the way: ${link}`;
        const r = await sendSMSResult(t.phone, msg);
        if (r.ok) newlyNudged.push(t.id);
        else console.warn(`[tech-late] nudge SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      // ── Stage 2: escalate to the office (and owner) ───────────────────────
      let staffSentThisPass = false;
      if (willEscalate) {
        const staffResult = await sendSMSResult(staffPhone, staffMsg);
        if (!staffResult.ok) console.warn(`[tech-late] office SMS failed for booking ${b.id}:`, staffResult.error || staffResult.skipped);
        if (ccOwner) {
          const ownerResult = await sendSMSResult(ownerPhoneRaw, staffMsg);
          if (!ownerResult.ok) console.warn(`[tech-late] owner SMS failed for booking ${b.id}:`, ownerResult.error || ownerResult.skipped);
        }
        // One-shot regardless of delivery outcome, matching the rest of this
        // codebase's notification-flag convention.
        staffSentThisPass = true;
      }

      if (newlyNudged.length || staffSentThisPass) {
        // Re-read fresh right before writing so a key written elsewhere during
        // our awaited sends isn't clobbered.
        const { data: freshRow, error: reErr } = await db.from('bookings').select('metadata').eq('id', b.id).maybeSingle();
        const freshMeta = (!reErr && freshRow && freshRow.metadata) || meta;
        const newMeta = { ...freshMeta };
        if (newlyNudged.length) {
          newMeta.otw_nudge_sent_ids = Array.from(new Set([...(freshMeta.otw_nudge_sent_ids || []).map(String), ...newlyNudged]));
          if (!freshMeta.otw_nudge_sent_at) newMeta.otw_nudge_sent_at = nowISO;
        }
        if (staffSentThisPass) newMeta.staff_late_notified_at = nowISO;
        const { error: upErr } = await db.from('bookings').update({ metadata: newMeta }).eq('id', b.id);
        if (upErr) console.warn(`[tech-late] sent but failed to mark booking ${b.id}:`, upErr.message);
      }

      if (newlyNudged.length) summary.nudged++;
      if (staffSentThisPass) summary.escalated++;
      summary.details.push({ id: b.id, slug, nudged: newlyNudged.length, escalated: staffSentThisPass });
      console.log(`[tech-late] booking=${b.id} slug=${slug} nudged=${newlyNudged.length} escalated=${staffSentThisPass}`);
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: b.id, error: e.message });
      console.error(`[tech-late] error on booking ${b.id}:`, e.message);
    }
  }

  console.log(`[tech-late] pass complete: checked=${summary.checked} nudged=${summary.nudged} escalated=${summary.escalated} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun}`);
  return summary;
}
