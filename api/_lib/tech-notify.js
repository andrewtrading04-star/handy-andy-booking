// api/_lib/tech-notify.js
// The "You got a job!" text a technician gets when they're assigned work.
//
// This used to be a private function inside api/admin.js, which meant the
// PUBLIC booking endpoint (api/book.js) physically could not send it — so every
// job a customer booked on the website auto-assigned a tech who was then never
// told. Living in _lib makes it importable from both. (_lib is not a route, so
// this does not count against Vercel's function cap.)
//
// Two other things it fixes versus the old version:
//  1. It AWAITS the provider call and returns the outcome. The old code was
//     doubly fire-and-forget (`sendSMS(...).catch()` inside a function that
//     callers also didn't await), and on Vercel the lambda can freeze the
//     instant the HTTP response goes out — so the Twilio request could simply
//     never be issued. Same hazard already documented for the on-the-way text
//     in api/tech.js.
//  2. It RECORDS every attempt in app.tech_sms_log with a Twilio status
//     callback, so a tech not getting texted is visible instead of silent.
import { sendSMSResult } from './sms.js';
import { signToken } from './auth.js';

function baseUrl() {
  return process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

// Best-effort audit row. Never allowed to break a booking: a logging failure
// (e.g. the migration not applied yet) must not stop the text or the caller.
async function logAttempt(db, row) {
  try {
    const { data } = await db.from('tech_sms_log').insert(row).select('id').maybeSingle();
    return data?.id || null;
  } catch { return null; }
}

// Text a technician that they've been given a job.
//
//   db             service-role Supabase client
//   biz            { id, name, timezone } of the business the JOB belongs to
//   technicianId   who to text (null/undefined is a no-op)
//   scheduledAtISO the job's start instant
//   areaTz         the job's METRO timezone (an Austin job is Central) — the
//                  business tz is only a fallback, or the tech is told the
//                  wrong hour
//   opts.bookingId       ties the log row to the job (enables owner-visible status)
//   opts.kind            'assigned' (default) | 'reassigned' | 'rescheduled'
//
// Returns { ok, skipped?, error?, logId? }. Callers should AWAIT this.
export async function notifyTechAssigned(db, biz, technicianId, scheduledAtISO, areaTz, opts = {}) {
  const kind = opts.kind || 'assigned';
  const bookingId = opts.bookingId || null;
  if (!technicianId) return { ok: false, skipped: 'no_technician' };

  // Look up by id ALONE (not business) so a cross-company tech — whose home
  // business differs from this booking's — is still found and texted.
  // The error is checked now: the old code destructured only `data`, so a
  // transient DB blip silently dropped the text with no log and no throw.
  const { data: tech, error: techErr } = await db.from('technicians')
    .select('phone, business_id').eq('id', technicianId).maybeSingle();
  if (techErr) {
    console.error('[tech-notify] technician lookup failed:', techErr.message);
    await logAttempt(db, {
      booking_id: bookingId, technician_id: technicianId, business_id: biz?.id || null,
      kind, status: 'failed', error: `tech lookup: ${techErr.message}`,
    });
    return { ok: false, error: techErr.message };
  }
  if (!tech?.phone) {
    await logAttempt(db, {
      booking_id: bookingId, technician_id: technicianId, business_id: biz?.id || null,
      kind, status: 'skipped', skip_reason: 'no_phone',
    });
    return { ok: false, skipped: 'no_phone' };
  }

  const tz = areaTz || biz?.timezone || 'America/Denver';
  let whenTxt = 'a new job';
  if (scheduledAtISO) {
    try {
      whenTxt = new Date(scheduledAtISO).toLocaleString('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch { /* keep generic */ }
  }

  const appLink = `${baseUrl()}/tech.html`;
  // Cross-company: the tech works for the other company today. Make it
  // unmistakable which business this job belongs to.
  const crossCompany = tech.business_id && biz?.id && tech.business_id !== biz.id;
  const forBiz = crossCompany ? ` for ${String(biz?.name || '').toUpperCase()} (not your own company)` : '';
  let msg;
  if (kind === 'unassigned') {
    // The job moved to a slot someone else is covering. No app link — there is
    // nothing for them to open, and the point is to STOP them driving out.
    msg = `Update: the job${forBiz} on ${whenTxt} was rescheduled by the customer and is no longer assigned to you. No action needed.`;
  } else if (kind === 'rescheduled') {
    msg = `One of your jobs${forBiz} MOVED to ${whenTxt}. Address & details in the app: ${appLink}`;
  } else {
    msg = `You got a job${forBiz}! ${whenTxt}. Address & details in the app: ${appLink}`;
  }

  // Log first so we always have a row id to attach the Twilio status callback
  // to — the callback can otherwise arrive before our own insert commits.
  const logId = await logAttempt(db, {
    booking_id: bookingId, technician_id: technicianId, business_id: biz?.id || null,
    kind, status: 'pending', to_phone: tech.phone,
  });

  // Twilio POSTs delivery updates here as the message progresses; see
  // api/analytics.js action=sms_status, kind 'tech_sms'.
  const statusCallback = logId
    ? `${baseUrl()}/api/analytics?action=sms_status&token=${encodeURIComponent(signToken({ kind: 'tech_sms', tech_sms_log_id: logId }, 86400))}`
    : undefined;

  const r = await sendSMSResult(tech.phone, msg, statusCallback ? { statusCallback } : {});

  if (logId) {
    const patch = r.ok
      ? { status: 'pending' }                                        // callback upgrades to delivered
      : r.skipped
        ? { status: 'skipped', skip_reason: r.skipped }
        : { status: 'failed', error: (r.error || 'unknown').slice(0, 500) };
    try { await db.from('tech_sms_log').update(patch).eq('id', logId); } catch { /* best effort */ }
  }
  if (!r.ok) {
    if (r.error) console.error('[tech-notify]', r.error);
    else console.warn('[tech-notify] not sent:', r.skipped);
  }
  return { ...r, logId };
}
