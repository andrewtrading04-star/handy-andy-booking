// api/_lib/tech-late.js
// Four-stage job punctuality flow, plus a tech self-report "running late"
// escape hatch. Driven by a scheduled trigger (GitHub Actions / Vercel cron,
// every ~10 min) that hits
//   GET /api/migrate?action=tech_late_check&secret=CRON_SECRET
//
// ── Why four stages ──────────────────────────────────────────────────────────
// One tap link, minted fresh on every text, carries the tech through all of
// this — it's the same /otw.html?token=... link the tech app's own "On My
// Way" button produces, and tapping "Send on my way" at ANY point (any stage,
// or before any stage has fired) does exactly what it does today: stamps
// on_the_way_at, texts the customer, and — because the query below filters on
// on_the_way_at IS NULL — drops the booking out of every future pass on its
// own. Nothing here ever has to "cancel" a later stage; the row just stops
// matching.
//
//   STAGE 1 — tech only, 30 minutes BEFORE the scheduled start.
//     A short heads-up with the tap link.
//   STAGE 2 — tech only, AT the scheduled start.
//     A second text once the slot has actually begun.
//   STAGE 3 — tech AND the office (secretary), 30 minutes AFTER the start.
//     The tech gets a "you're late" text. The office gets a separate
//     "heads up, he hasn't tapped" text to the SAME number stage 2's old
//     escalation went to. These two sends are tracked and gated
//     independently — a retry of one is possible without re-sending the
//     other.
//   STAGE 4 — tech AND the office AND the owner, 40 minutes AFTER the start.
//     A louder ATTENTION text to the tech, and a matching one to the office
//     with the owner cc'd (only when the owner's number differs from the
//     office's).
//
// Every stage is gated by its OWN one-shot/per-tech marker (see below), never
// by a narrow time window — a stage that was missed entirely (a cron outage,
// a deploy) still fires on the very next pass, same as the old design. A
// stage, once due, STAYS due until its marker says it was sent.
//
// ── Tech self-report: "I'm running late" ────────────────────────────────────
// The SAME tap link every stage's tech text carries opens public/otw.html,
// which offers a second, lower-emphasis action next to "Send on my way":
// POST /api/book?action=report_late (see reportLate() in api/book.js). That
// stamps metadata.late_reported_at / late_reported_by, texts the office
// exactly once, and PERMANENTLY takes the booking out of every future pass
// of checkLateTechs — checked first thing in the per-booking loop, before any
// stage-due computation. It does NOT touch on_the_way_at or status: from the
// customer's perspective the job hasn't started, this only quiets the
// internal nudge system and lets the office know why. "Send on my way" still
// works normally afterward (or before), independently.
//
// ── Idempotency markers (all in bookings.metadata) ──────────────────────────
//   * stage1_sent_ids                — tech ids sent Stage 1
//   * stage2_sent_ids                — tech ids sent Stage 2
//   * stage3_tech_sent_ids           — tech ids sent Stage 3's TECH text
//   * staff_late_notified_at         — one-shot ISO timestamp, set when Stage
//                                      3's OFFICE text is (attempted to be)
//                                      sent. KEEP THIS EXACT NAME — api/
//                                      admin.js's tech scorecard (late_30d)
//                                      reads it directly and would silently
//                                      break if this were renamed.
//   * stage4_tech_sent_ids           — tech ids sent Stage 4's TECH text
//   * stage4_staff_owner_notified_at — one-shot ISO timestamp, set when Stage
//                                      4's OFFICE+OWNER text is (attempted to
//                                      be) sent.
//   * late_reported_at / late_reported_by — set by report_late. Presence of
//                                      late_reported_at is a PERMANENT stop:
//                                      all 4 stages are skipped forever once
//                                      it's set.
//
//   Legacy compat (bookings created/in-flight under the OLD 2-stage code
//   before this deploy landed): the old code wrote otw_nudge_sent_ids (and,
//   before that, tech_late_notified_ids) for "already got the one pre-job
//   nudge", and staff_late_notified_at — which is already the exact field
//   this design reuses for Stage 3's office send, so that one needs no shim.
//   But a tech who already has EITHER legacy array for this booking already
//   got the one nudge the old code sent; he should not ALSO get a fresh
//   Stage 1 AND Stage 2 text stacked on top of it. So presence of either
//   legacy id folds into BOTH the stage1 and stage2 "already sent" sets
//   below, for that tech only.
//
// Reassigning either tech (api/admin.js "assign") clears these markers and
// stamps metadata.reassigned_at; reopening stamps reopened_at. Those grace
// stamps suppress the OFFICE-facing sends only (Stage 3 and Stage 4's
// secretary+owner texts) — a freshly assigned tech still gets his OWN texts
// immediately, since the whole point of those is to tell him.
//
// The final metadata write re-reads the row immediately beforehand (rather
// than reusing the pass-start snapshot) and merges onto THAT, so a slow pass
// can't clobber a key some other part of the app wrote in the meantime.
import { serviceClient } from './supabase.js';
import { sendSMSResult, toE164 } from './sms.js';
import { signToken } from './auth.js';
import { SECRETARY_EXTRA_BUSINESSES } from './staff-access.js';

const MIN = 60 * 1000;

// ── Stage timings, all relative to scheduled_at. Changing any is a one-line edit. ──
const STAGE1_LEAD_MS = 30 * MIN;      // stage 1 fires this long BEFORE the start
const STAGE3_AFTER_MS = 30 * MIN;     // stage 3 fires this long AFTER the start
const STAGE4_AFTER_MS = 40 * MIN;     // stage 4 fires this long AFTER the start
const NUDGE_LINK_TTL_S = 8 * 60 * 60; // one-tap link stays good this long

const LOOKBACK_MS = 24 * 60 * MIN;    // ignore anything older than this (stale data, not a fresh no-show)
const REASSIGN_GRACE_MS = 30 * MIN;   // a freshly (re)assigned tech can't trigger an OFFICE send for this long

// Statuses meaning nobody has finished or cancelled the job. Paired with the
// on_the_way_at IS NULL check below (belt and suspenders: a job reopened back
// into one of these after a tech genuinely went en route is still excluded by
// on_the_way_at, not just this list).
const NOT_EN_ROUTE_STATUSES = ['pending', 'confirmed', 'assigned'];

// business slug -> office phone env var. Built from the SAME map that grants
// dashboard/call access (api/_lib/staff-access.js) rather than hand-
// duplicated here, after that duplication already drifted once: the eight
// brands Joey took over on 2026-08-25 were absent from this file entirely for
// a while, so a late job on one escalated to NOBODY — the loop logged "no
// office number configured for business" and moved on, the quietest possible
// way to leave a customer waiting on a tech who never showed. These brands
// (lead-gen, Austin/Houston, no techs of their own — the work is done by
// cross-hired Handy Andy techs) have no dispatcher but the CUSTOMER is still
// whoever answers that brand's phone to account for.
const STAFF_PHONE_ENV = {
  'handy-andy': 'HEATHER_PHONE_NUMBER',
  'doms': 'JOEY_PHONE_NUMBER',
  ...Object.fromEntries((SECRETARY_EXTRA_BUSINESSES['handy-andy'] || []).map(slug => [slug, 'HEATHER_PHONE_NUMBER'])),
  ...Object.fromEntries((SECRETARY_EXTRA_BUSINESSES.doms || []).map(slug => [slug, 'JOEY_PHONE_NUMBER'])),
};

// Fallbacks for the vars above, so an UNSET one cannot silently turn a late-job
// notification into nothing. Both owner-confirmed (Joey 2026-08-25, Heather
// 2026-08-26) and matching both staff_users.phone and each person's
// tracking-number routing.
const STAFF_PHONE_FALLBACK = { JOEY_PHONE_NUMBER: '3032190118', HEATHER_PHONE_NUMBER: '7207223653' }; // Heather's number updated 2026-09-18

// The ONE place the business-slug -> office-phone mapping is resolved.
// api/book.js's report_late handler imports this instead of re-deriving it —
// see the incident noted on STAFF_PHONE_ENV above for why that duplication is
// not allowed to happen again. Returns null when the business has no office
// number configured (env var missing/unmapped) rather than throwing, so a
// caller decides what "unconfigured" means for it.
export function officePhoneFor(slug) {
  const envVar = slug ? STAFF_PHONE_ENV[slug] : null;
  if (!envVar) return null;
  return process.env[envVar] || STAFF_PHONE_FALLBACK[envVar] || null;
}

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'Tech';
}

function baseUrl() {
  return process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

// One batched Map(service_area_id -> { timezone, name }) so each job can be
// described in its OWN metro's clock and city name (an Austin job is Central
// and "Austin"), not the server's or the business's generic one.
async function areaInfoMap(db, ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return {};
  try {
    const { data } = await db.from('service_areas').select('id, timezone, name').in('id', uniq);
    return Object.fromEntries((data || []).map(r => [r.id, { timezone: r.timezone, name: r.name }]));
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

// Fresh signed one-tap link, minted per send — same token kind/TTL as always,
// so the existing otw.html/otwInfo/otwSend flow (and now reportLate) keeps
// working unchanged.
function mintOtwLink(bookingId, techId) {
  const token = signToken({ kind: 'otw_quick', booking_id: bookingId, tech_id: techId }, NUDGE_LINK_TTL_S);
  return `${baseUrl()}/otw.html?token=${encodeURIComponent(token)}`;
}

// Run one pass. Returns a summary; never throws on a single bad row.
//   opts.dryRun — find + report what would happen without sending anything.
export async function checkLateTechs(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  // Upper bound reaches into the near future so stage 1 can fire BEFORE the
  // start. Cron granularity is ~10 min, so a job is caught by whichever pass
  // first sees it inside the lead window.
  const horizonISO = new Date(now + STAGE1_LEAD_MS).toISOString();
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

  const areaById = await areaInfoMap(db, (rows || []).map(r => r.service_area_id));

  const summary = {
    checked: 0, stage1: 0, stage2: 0, stage3_tech: 0, stage3_staff: 0,
    stage4_tech: 0, stage4_staff: 0, skipped: 0, errors: 0, details: [],
  };

  for (const b of rows || []) {
    // Neither tech assigned — that's an unstaffed-job problem, not a
    // punctuality one. Nothing to text and nobody to name.
    if (!b.technician_id && !b.secondary_technician_id) continue;
    summary.checked++;

    const meta = b.metadata || {};

    // Permanent stop: the tech already told us himself via report_late.
    if (meta.late_reported_at) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: 'tech self-reported late' });
      continue;
    }

    const biz = bizById.get(b.business_id) || {};
    const slug = biz.slug;
    const customerName = b.customer?.name || 'the customer';
    const areaInfo = areaById[b.service_area_id] || {};
    const tz = areaInfo.timezone || biz.timezone || 'America/Denver';
    const city = areaInfo.name || biz.name || 'your area';

    const schedMs = Date.parse(b.scheduled_at);
    if (!Number.isFinite(schedMs)) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: 'unparseable scheduled_at' });
      continue;
    }
    const msSinceStart = now - schedMs;
    const stage1Due = msSinceStart >= -STAGE1_LEAD_MS;
    const stage2Due = msSinceStart >= 0;
    const stage3Due = msSinceStart >= STAGE3_AFTER_MS;
    const stage4Due = msSinceStart >= STAGE4_AFTER_MS;

    // Every assigned tech (primary + secondary, deduped) with a phone on
    // file — the only techs any of this can actually reach.
    const techsWithPhone = [];
    if (b.technician?.phone) techsWithPhone.push({ id: String(b.technician_id), name: b.technician.name, phone: b.technician.phone });
    if (b.secondary_technician?.phone && b.secondary_technician_id !== b.technician_id) {
      techsWithPhone.push({ id: String(b.secondary_technician_id), name: b.secondary_technician.name, phone: b.secondary_technician.phone });
    }

    // Legacy key(s) count as "already got the one pre-job nudge" — see the
    // header comment's Legacy compat note. Folds into BOTH stage1 and stage2
    // so a tech mid-flight across this deploy isn't double-texted.
    const legacyAlready = new Set([
      ...(meta.otw_nudge_sent_ids || []).map(String),
      ...(meta.tech_late_notified_ids || []).map(String),
    ]);
    const stage1Already = new Set([...(meta.stage1_sent_ids || []).map(String), ...legacyAlready]);
    const stage2Already = new Set([...(meta.stage2_sent_ids || []).map(String), ...legacyAlready]);
    const stage3TechAlready = new Set((meta.stage3_tech_sent_ids || []).map(String));
    const stage4TechAlready = new Set((meta.stage4_tech_sent_ids || []).map(String));

    const pendingStage1 = stage1Due ? techsWithPhone.filter(t => !stage1Already.has(t.id)) : [];
    const pendingStage2 = stage2Due ? techsWithPhone.filter(t => !stage2Already.has(t.id)) : [];
    const pendingStage3Tech = stage3Due ? techsWithPhone.filter(t => !stage3TechAlready.has(t.id)) : [];
    const pendingStage4Tech = stage4Due ? techsWithPhone.filter(t => !stage4TechAlready.has(t.id)) : [];

    const stage3StaffAlreadyDone = !!meta.staff_late_notified_at;
    const stage4StaffAlreadyDone = !!meta.stage4_staff_owner_notified_at;

    // OFFICE sends are suppressed during the grace window after a
    // reassignment or reopen (the tech may have only just inherited this
    // slot). The TECH-facing texts are deliberately NEVER suppressed by the
    // grace period — those are the ones telling him.
    let officeBlockedBy = null;
    const graceAnchor = meta.reassigned_at && meta.reopened_at
      ? (Date.parse(meta.reassigned_at) > Date.parse(meta.reopened_at) ? meta.reassigned_at : meta.reopened_at)
      : (meta.reassigned_at || meta.reopened_at);
    if (graceAnchor) {
      const anchorMs = Date.parse(graceAnchor);
      if (Number.isFinite(anchorMs) && (now - anchorMs) < REASSIGN_GRACE_MS) {
        officeBlockedBy = 'reassignment/reopen grace period';
      }
    }

    const staffPhone = officePhoneFor(slug);
    if (!officeBlockedBy && !staffPhone) {
      officeBlockedBy = (slug && STAFF_PHONE_ENV[slug])
        ? `${STAFF_PHONE_ENV[slug]} env var not set`
        : `no office number configured for business (${slug || b.business_id})`;
    }

    const willStage3Staff = stage3Due && !stage3StaffAlreadyDone && !officeBlockedBy;
    const willStage4Staff = stage4Due && !stage4StaffAlreadyDone && !officeBlockedBy;

    if (!pendingStage1.length && !pendingStage2.length && !pendingStage3Tech.length
      && !pendingStage4Tech.length && !willStage3Staff && !willStage4Staff) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip: stage1Due ? (officeBlockedBy || 'already handled / nothing due') : 'not due yet' });
      continue;
    }

    const whenTxt = timeInTz(b.scheduled_at, tz) || 'scheduled';
    // {techNames} is every ASSIGNED tech WITH A PHONE (the only ones any tap
    // link could ever reach) — same join-with-"and" construction as before.
    const techNames = techsWithPhone.map(t => firstName(t.name));
    const namesJoined = techNames.length ? techNames.join(' and ') : 'The assigned tech';
    const multi = techNames.length > 1;

    // Never show less than the rule itself, even if clocks drift a little.
    const stage3LateMinutes = Math.max(Math.round(STAGE3_AFTER_MS / MIN), Math.round(msSinceStart / MIN));
    const stage4LateMinutes = Math.max(Math.round(STAGE4_AFTER_MS / MIN), Math.round(msSinceStart / MIN));

    const ownerPhoneRaw = process.env.OWNER_PHONE_NUMBER;
    const ccOwner = !!ownerPhoneRaw && !!staffPhone && toE164(ownerPhoneRaw) !== toE164(staffPhone);

    if (dryRun) {
      summary.details.push({
        id: b.id, slug,
        wouldStage1: pendingStage1.map(t => t.name),
        wouldStage2: pendingStage2.map(t => t.name),
        wouldStage3Tech: pendingStage3Tech.map(t => t.name),
        wouldStage3Staff: willStage3Staff ? staffPhone : null,
        wouldStage4Tech: pendingStage4Tech.map(t => t.name),
        wouldStage4StaffOwner: willStage4Staff ? { staff: staffPhone, owner: ccOwner ? ownerPhoneRaw : null } : null,
      });
      if (pendingStage1.length) summary.stage1++;
      if (pendingStage2.length) summary.stage2++;
      if (pendingStage3Tech.length) summary.stage3_tech++;
      if (willStage3Staff) summary.stage3_staff++;
      if (pendingStage4Tech.length) summary.stage4_tech++;
      if (willStage4Staff) summary.stage4_staff++;
      continue;
    }

    try {
      // ── Stage 1: tech, 30 min before start ────────────────────────────────
      const newly1 = [];
      for (const t of pendingStage1) {
        const link = mintOtwLink(b.id, t.id);
        const msg = `Your job in ${city} starts in 30 minutes. Tap when you're on the way: ${link}`;
        const r = await sendSMSResult(t.phone, msg);
        if (r.ok) newly1.push(t.id);
        else console.warn(`[tech-late] stage1 SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      // ── Stage 2: tech, at start ────────────────────────────────────────────
      const newly2 = [];
      for (const t of pendingStage2) {
        const link = mintOtwLink(b.id, t.id);
        const msg = `Your job in ${city} just started. Tap to let them know you're on the way: ${link}`;
        const r = await sendSMSResult(t.phone, msg);
        if (r.ok) newly2.push(t.id);
        else console.warn(`[tech-late] stage2 SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      // ── Stage 3: tech + office, 30 min after start ─────────────────────────
      const newly3Tech = [];
      for (const t of pendingStage3Tech) {
        const link = mintOtwLink(b.id, t.id);
        const msg = `You are ${stage3LateMinutes} minutes late for your ${whenTxt} job. Tap now: ${link}`;
        const r = await sendSMSResult(t.phone, msg);
        if (r.ok) newly3Tech.push(t.id);
        else console.warn(`[tech-late] stage3 tech SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      let stage3StaffSentThisPass = false;
      if (willStage3Staff) {
        const staffMsg = `Heads up: ${namesJoined} ${multi ? "haven't" : "hasn't"} tapped on-the-way for ${customerName}'s job (${whenTxt}), started ${stage3LateMinutes} min ago.`;
        const staffResult = await sendSMSResult(staffPhone, staffMsg);
        if (!staffResult.ok) console.warn(`[tech-late] stage3 office SMS failed for booking ${b.id}:`, staffResult.error || staffResult.skipped);
        // One-shot regardless of delivery outcome, matching the rest of this
        // codebase's notification-flag convention.
        stage3StaffSentThisPass = true;
      }

      // ── Stage 4: tech + office + owner, 40 min after start ─────────────────
      const newly4Tech = [];
      for (const t of pendingStage4Tech) {
        const link = mintOtwLink(b.id, t.id);
        const msg = `ATTENTION: You are LATE for your appointment at ${whenTxt} — tap on-the-way for ${customerName}'s job now: ${link}`;
        const r = await sendSMSResult(t.phone, msg);
        if (r.ok) newly4Tech.push(t.id);
        else console.warn(`[tech-late] stage4 tech SMS failed for booking ${b.id} (tech ${t.id}), will retry next pass:`, r.error || r.skipped);
      }

      let stage4StaffSentThisPass = false;
      if (willStage4Staff) {
        const staffMsg = `ATTENTION: ${namesJoined} ${multi ? 'are' : 'is'} ${stage4LateMinutes} minutes late to ${customerName}'s job and still ${multi ? "haven't" : "hasn't"} responded. Please follow up.`;
        const staffResult = await sendSMSResult(staffPhone, staffMsg);
        if (!staffResult.ok) console.warn(`[tech-late] stage4 office SMS failed for booking ${b.id}:`, staffResult.error || staffResult.skipped);
        if (ccOwner) {
          const ownerResult = await sendSMSResult(ownerPhoneRaw, staffMsg);
          if (!ownerResult.ok) console.warn(`[tech-late] stage4 owner SMS failed for booking ${b.id}:`, ownerResult.error || ownerResult.skipped);
        }
        stage4StaffSentThisPass = true;
      }

      const anySent = newly1.length || newly2.length || newly3Tech.length
        || stage3StaffSentThisPass || newly4Tech.length || stage4StaffSentThisPass;

      if (anySent) {
        // Re-read fresh right before writing so a key written elsewhere
        // during our awaited sends isn't clobbered.
        const { data: freshRow, error: reErr } = await db.from('bookings').select('metadata').eq('id', b.id).maybeSingle();
        if (reErr) console.warn(`[tech-late] re-read before write failed for booking ${b.id}, falling back to pass-start snapshot:`, reErr.message);
        const freshMeta = (!reErr && freshRow && freshRow.metadata) || meta;
        const newMeta = { ...freshMeta };
        if (newly1.length) newMeta.stage1_sent_ids = Array.from(new Set([...(freshMeta.stage1_sent_ids || []).map(String), ...newly1]));
        if (newly2.length) newMeta.stage2_sent_ids = Array.from(new Set([...(freshMeta.stage2_sent_ids || []).map(String), ...newly2]));
        if (newly3Tech.length) newMeta.stage3_tech_sent_ids = Array.from(new Set([...(freshMeta.stage3_tech_sent_ids || []).map(String), ...newly3Tech]));
        if (stage3StaffSentThisPass) newMeta.staff_late_notified_at = nowISO;
        if (newly4Tech.length) newMeta.stage4_tech_sent_ids = Array.from(new Set([...(freshMeta.stage4_tech_sent_ids || []).map(String), ...newly4Tech]));
        if (stage4StaffSentThisPass) newMeta.stage4_staff_owner_notified_at = nowISO;
        const { error: upErr } = await db.from('bookings').update({ metadata: newMeta }).eq('id', b.id);
        if (upErr) console.warn(`[tech-late] sent but failed to mark booking ${b.id}:`, upErr.message);
      }

      if (newly1.length) summary.stage1++;
      if (newly2.length) summary.stage2++;
      if (newly3Tech.length) summary.stage3_tech++;
      if (stage3StaffSentThisPass) summary.stage3_staff++;
      if (newly4Tech.length) summary.stage4_tech++;
      if (stage4StaffSentThisPass) summary.stage4_staff++;
      summary.details.push({
        id: b.id, slug, stage1: newly1.length, stage2: newly2.length,
        stage3_tech: newly3Tech.length, stage3_staff: stage3StaffSentThisPass,
        stage4_tech: newly4Tech.length, stage4_staff: stage4StaffSentThisPass,
      });
      console.log(`[tech-late] booking=${b.id} slug=${slug} stage1=${newly1.length} stage2=${newly2.length} stage3_tech=${newly3Tech.length} stage3_staff=${stage3StaffSentThisPass} stage4_tech=${newly4Tech.length} stage4_staff=${stage4StaffSentThisPass}`);
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: b.id, error: e.message });
      console.error(`[tech-late] error on booking ${b.id}:`, e.message);
    }
  }

  console.log(`[tech-late] pass complete: checked=${summary.checked} stage1=${summary.stage1} stage2=${summary.stage2} stage3_tech=${summary.stage3_tech} stage3_staff=${summary.stage3_staff} stage4_tech=${summary.stage4_tech} stage4_staff=${summary.stage4_staff} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun}`);
  return summary;
}
