// api/_lib/reminders.js
// 24-hour appointment reminder engine. Driven by a scheduled trigger (Vercel
// Cron and/or a GitHub Actions hourly workflow) that hits
//   GET /api/migrate?action=send_reminders&secret=CRON_SECRET
//
// Design goals:
//   * Idempotent — a booking is reminded at most once. State is stored in the
//     existing bookings.metadata JSONB (metadata.reminder_sent_at), so NO schema
//     migration is required.
//   * "Same-day" bookings are ignored — we only remind customers who booked at
//     least 24h ahead (scheduled_at - created_at >= 24h). A job booked the same
//     day (or otherwise inside 24h) never qualifies.
//   * Fires ~24h out — we remind any eligible booking whose appointment is within
//     the next 24 hours and hasn't been reminded yet. With an hourly trigger this
//     lands right around the 24-hour mark; a missed hour is caught the next run.
//   * Brand-aware — only businesses with a configured email brand (Handy Andy,
//     Doms) are emailed, each with its own colors/sender. Gated by the global
//     email switch + the per-business Resend key, exactly like every other send.
import { serviceClient } from './supabase.js';
import { emailNotificationsOn } from './notify.js';
import { appointmentReminderEmail, emailConfig, sendEmail, brandFor, EMAIL_BRANDS } from './email.js';

const HOUR = 60 * 60 * 1000;
const ADVANCE_MS = 24 * HOUR;   // must have booked at least this far ahead
const WINDOW_MS  = 24 * HOUR;   // remind when appointment is within this many hours

// Statuses that still represent an upcoming, un-started job worth reminding.
const REMINDER_STATUSES = ['pending', 'confirmed', 'assigned'];

// Run one reminder pass. Returns a summary; never throws on a single bad row.
//   opts.dryRun  — find + log eligible bookings but send nothing, mark nothing.
export async function sendAppointmentReminders(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const windowEndISO = new Date(now + WINDOW_MS).toISOString();

  // Map business_id -> { slug, timezone } so we can pick brand/sender + format
  // the date in the business's local time.
  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug, timezone');
  if (bizErr) throw new Error(`businesses query failed: ${bizErr.message}`);
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));

  // Candidate bookings: upcoming within the next 24h, not yet started/cancelled.
  const { data: rows, error } = await db
    .from('bookings')
    .select('id, business_id, status, scheduled_at, created_at, metadata, address_line1, city, state, postal_code, customer:customers ( name, email )')
    .in('status', REMINDER_STATUSES)
    .gt('scheduled_at', nowISO)
    .lte('scheduled_at', windowEndISO);
  if (error) throw new Error(`bookings query failed: ${error.message}`);

  const summary = { checked: 0, sent: 0, skipped: 0, errors: 0, details: [] };

  for (const b of rows || []) {
    summary.checked++;
    const biz = bizById.get(b.business_id) || {};
    const slug = biz.slug;
    const meta = b.metadata || {};
    const email = b.customer?.email || '';
    const schedMs = b.scheduled_at ? Date.parse(b.scheduled_at) : NaN;
    const createdMs = b.created_at ? Date.parse(b.created_at) : NaN;

    // ---- Eligibility gates (each records a skip reason for observability) ----
    let skip = null;
    if (!slug || !EMAIL_BRANDS[slug]) skip = `no email brand for business (${slug || b.business_id})`;
    else if (!email) skip = 'no customer email';
    else if (meta.reminder_sent_at) skip = 'already reminded';
    else if (!Number.isFinite(schedMs) || !Number.isFinite(createdMs)) skip = 'missing scheduled_at/created_at';
    else if (schedMs - createdMs < ADVANCE_MS) skip = 'booked inside 24h (same-day) - ignored';

    if (skip) {
      summary.skipped++;
      summary.details.push({ id: b.id, skip });
      continue;
    }

    // ---- Build the branded reminder ----
    const brand = brandFor(slug);
    const tz = biz.timezone || 'America/Denver';
    let dateLong = '';
    try {
      dateLong = new Date(schedMs).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch { /* leave blank */ }
    let timeWindow = '';
    try {
      const start = new Date(schedMs);
      const end = new Date(schedMs + 2 * HOUR);
      const fmt = (d) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
      timeWindow = `${fmt(start)} - ${fmt(end)}`;
    } catch { /* leave blank */ }

    const firstName = (b.customer?.name || '').trim().split(/\s+/)[0] || '';
    const { subject, html } = appointmentReminderEmail({
      firstName,
      dateLong,
      timeWindow,
      address: { line1: b.address_line1, city: b.city, state: b.state, zip: b.postal_code },
    }, brand);

    if (dryRun) {
      summary.sent++; // count as "would send"
      summary.details.push({ id: b.id, wouldSend: email, slug });
      continue;
    }

    try {
      const { from } = emailConfig(slug);
      const result = await sendEmail({ slug, to: email, subject, html, replyTo: from });
      if (result.sent) {
        // Mark sent in metadata (merge, never clobber other keys).
        const newMeta = { ...meta, reminder_sent_at: nowISO };
        const { error: upErr } = await db.from('bookings').update({ metadata: newMeta }).eq('id', b.id);
        if (upErr) console.warn(`[reminders] sent but failed to mark booking ${b.id}:`, upErr.message);
        summary.sent++;
        summary.details.push({ id: b.id, sent: email, slug, id_resend: result.id || null });
        console.log(`[reminders] reminder SENT to ${email} (${slug}) booking=${b.id}`);
      } else {
        // Not sent (switch off / no key / Resend error) — do NOT mark, so it
        // retries next run once the underlying issue is fixed.
        summary.skipped++;
        summary.details.push({ id: b.id, notSent: result.skipped || result.error });
        console.warn(`[reminders] reminder NOT sent to ${email} (${slug}) booking=${b.id}:`, result.skipped || result.error);
      }
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: b.id, error: e.message });
      console.error(`[reminders] error on booking ${b.id}:`, e.message);
    }
  }

  console.log(`[reminders] pass complete: checked=${summary.checked} sent=${summary.sent} skipped=${summary.skipped} errors=${summary.errors} dryRun=${dryRun} emailSwitch=${emailNotificationsOn()}`);
  return summary;
}
