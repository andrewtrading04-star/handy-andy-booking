// ============================================================================
// Technician app API (consolidated router).
//
//   POST login   { phone, pin }            -> { token, technician }
//   GET  jobs                              -> today's jobs for the logged-in tech
//   GET  job     ?id=                      -> one job's full detail
//   POST status  { id, status, note }      -> on_the_way|arrived|in_progress|completed
//
// A tech only ever sees their OWN jobs — the tech id comes from the signed
// token, never from the request body. Status changes also flip the tech's
// availability so it reflects in the admin dashboard.
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { smsNotificationsOn } from './_lib/notify.js';
import { emailConfig, sendEmail, brandFor, reviewEmail } from './_lib/email.js';
import { localDayStartUTC, localDateStartUTC, addDaysStr, startOfWeekUTC } from './_lib/time.js';
import { SLOTS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows } from './_lib/availability.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod } from './_lib/stripe.js';
import { uploadImage, deleteImage } from './_lib/storage.js';
import { computeJobPay, PAY_DATE_OFFSET_DAYS } from './_lib/payroll.js';

// A job is not "complete" until the tech has documented it with photos.
const MIN_PHOTOS_TO_COMPLETE = 2;

// ── Job ownership ────────────────────────────────────────────────────────────
// A job "belongs" to a tech when they are the PRIMARY *or* the SECOND technician,
// so a helper — including a cross-company one — can see and fully work the job in
// their own app. Some deployments predate the 0019 secondary_technician_id
// column; if a query referencing it errors, fall back to primary-only matching.
let techHasSecondCol = true;
function scopeMine(q, auth) {
  return techHasSecondCol
    ? q.or(`technician_id.eq.${auth.tech_id},secondary_technician_id.eq.${auth.tech_id}`)
    : q.eq('technician_id', auth.tech_id);
}
// Run a bookings query (rebuilt fresh on each call so it can be retried) with the
// primary-OR-second-tech scope, dropping the secondary column if the schema
// lacks it. `build()` must return a not-yet-awaited Supabase query.
async function fetchMine(build) {
  let r = await build();
  if (r.error && /secondary_technician_id/.test(r.error.message || '')) {
    techHasSecondCol = false;
    r = await build();
  }
  return r;
}

// ── SMS Helper ──────────────────────────────────────────────────────────────
// Normalize US/CA numbers to E.164 (+1XXXXXXXXXX), which Twilio requires.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

async function sendSMS(phoneNumber, message) {
  if (!smsNotificationsOn()) { console.log('[SMS] notifications disabled; not sent:', message); return; }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('[SMS] Twilio not configured; message not sent:', message);
    return;
  }
  const to = toE164(phoneNumber);
  if (!to) { console.warn('[SMS] Unusable phone, not sent:', phoneNumber); return; }
  const formData = new URLSearchParams();
  formData.append('From', process.env.TWILIO_PHONE_NUMBER);
  formData.append('To', to);
  formData.append('Body', message);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}` },
      body: formData,
    });
    if (!res.ok) { const t = await res.text().catch(()=> ''); throw new Error(`Twilio ${res.status}: ${t.slice(0,300)}`); }
    console.log('[SMS] Sent to', to.slice(-4));
  } catch (e) {
    console.error('[SMS]', e.message);
  }
}

// Status a technician is allowed to set, and how it maps to availability + the
// matching lifecycle timestamp on the booking.
const TECH_STATUS = {
  on_the_way:  { tech: 'on_job',    stamp: 'on_the_way_at' },
  arrived:     { tech: 'on_job',    stamp: 'arrived_at' },
  in_progress: { tech: 'on_job',    stamp: null },
  completed:   { tech: 'available', stamp: 'completed_at' },
};

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);
    // Dev bypass (only when TECH_DEV_BYPASS is set) — log in without a PIN
    // while the app is still being built. Remove the env var for production.
    if (action === 'dev_techs') return await devTechs(req, res);
    if (action === 'dev_login') return await devLogin(req, res, body);
    if (action === 'diagnostic') return await diagnostic(req, res);

    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'tech') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();
    switch (action) {
      case 'jobs':             return await jobs(req, res, db, auth);
      case 'job':              return await job(req, res, db, auth);
      case 'status':           return await status(req, res, db, auth, body);
      case 'job_payment':      return await jobPayment(req, res, db, auth, body);
      case 'job_photos':       return await jobPhotos(req, res, db, auth);
      case 'job_photo_add':    return await jobPhotoAdd(req, res, db, auth, body);
      case 'job_photo_delete': return await jobPhotoDelete(req, res, db, auth, body);
      case 'job_notes':        return await jobNotes(req, res, db, auth);
      case 'job_note_add':     return await jobNoteAdd(req, res, db, auth, body);
      case 'job_note_delete':  return await jobNoteDelete(req, res, db, auth, body);
      case 'availability':     return await getAvailability(req, res, db, auth);
      case 'availability_set': return await setAvailability(req, res, db, auth, body);
      case 'availability_exception_set': return await setAvailabilityException(req, res, db, auth, body);
      case 'tech_payroll':     return await techPayroll(req, res, db, auth);
      case 'tech_reviews':     return await techReviews(req, res, db, auth);
      case 'bracket_inventory': return await bracketInventory(req, res, db, auth);
      default:                 return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[tech]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function login(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawPhone = (body.phone || '').toString().trim();
  const pin = (body.pin || '').toString().trim();
  if (!rawPhone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

  const db = serviceClient();
  // The number a tech types ("(720) 656-8761") rarely matches how it's stored
  // in the DB ("+17206568761"). verify_technician_pin does an EXACT string
  // compare, so we try the input in every canonical form — E.164, raw, and
  // digits-only — until one matches. This lets a tech type their number however
  // they like, regardless of which format is on their record.
  const digits = rawPhone.replace(/\D/g, '');
  const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  const candidates = [...new Set([
    toE164(rawPhone),   // +17206568761
    rawPhone,           // (720) 656-8761  (covers records stored verbatim)
    digits,             // 17206568761 or 7206568761
    national,           // 7206568761
  ].filter(Boolean))];

  // Verify against the hashed PIN inside the DB; the hash never leaves Postgres.
  let tech = null, error = null;
  for (const cand of candidates) {
    const r = await db.rpc('verify_technician_pin', { p_phone: cand, p_pin: pin });
    if (r.error) { error = r.error; break; }
    const t = Array.isArray(r.data) ? r.data[0] : r.data;
    if (t) { tech = t; break; }
  }
  if (error) throw error;
  if (!tech) return res.status(401).json({ error: 'Incorrect phone or PIN' });

  const token = signToken({ kind: 'tech', tech_id: tech.id, business_id: tech.business_id });
  let slug = '', tz = 'America/Denver';
  try {
    const { data: biz } = await db.from('businesses').select('slug, timezone').eq('id', tech.business_id).single();
    slug = biz?.slug || '';
    tz = biz?.timezone || 'America/Denver';
  } catch { /* slug/tz are cosmetic — ignore lookup failures */ }
  return res.status(200).json({
    token,
    technician: { id: tech.id, name: tech.name, status: tech.status, slug, tz },
  });
}

function devBypassOn() {
  // Off by default so production is locked to phone + PIN. Set TECH_DEV_BYPASS=1
  // ONLY in a non-production environment to re-enable the no-PIN tech picker.
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.TECH_DEV_BYPASS || '').toLowerCase());
}

// List every technician (with business) so the dev login screen can pick one.
async function devTechs(req, res) {
  if (!devBypassOn()) return res.status(403).json({ error: 'Dev bypass disabled' });
  const db = serviceClient();
  const { data, error } = await db.from('technicians')
    .select('id, name, business_id, businesses ( slug, name )')
    .eq('active', true).order('name');
  if (error) throw error;
  return res.status(200).json({
    technicians: (data || []).map(t => ({
      id: t.id, name: t.name, business_id: t.business_id,
      business: t.businesses?.name || '', slug: t.businesses?.slug || '',
    })),
  });
}

// Issue a tech token for a chosen technician, no PIN required.
async function devLogin(req, res, body) {
  if (!devBypassOn()) return res.status(403).json({ error: 'Dev bypass disabled' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const db = serviceClient();
  const { data: tech, error } = await db.from('technicians')
    .select('id, name, status, business_id, businesses ( slug, timezone )').eq('id', body.tech_id).single();
  if (error || !tech) return res.status(404).json({ error: 'Technician not found' });
  const token = signToken({ kind: 'tech', tech_id: tech.id, business_id: tech.business_id });
  return res.status(200).json({ token, technician: { id: tech.id, name: tech.name, status: tech.status, slug: tech.businesses?.slug || '', tz: tech.businesses?.timezone || 'America/Denver' } });
}

// Diagnostic: show login readiness for all technicians (phone + PIN setup).
// Shows the EXACT stored phone string so a format mismatch is obvious, and
// reports whether a PIN hash exists. No secrets are leaked (hash itself stays
// in Postgres). Read-only.
async function diagnostic(req, res) {
  const db = serviceClient();
  const { data, error } = await db.from('technicians')
    .select('id, name, phone, active, pin_hash')
    .eq('active', true)
    .order('name');
  if (error) throw error;

  const ready = [];
  const missing = [];

  for (const t of data || []) {
    const issues = [];
    if (!t.phone) issues.push('missing phone');
    if (!t.pin_hash) issues.push('missing PIN');

    if (issues.length) {
      missing.push({ id: t.id, name: t.name, stored_phone: t.phone || null, issues });
    } else {
      ready.push({ id: t.id, name: t.name, stored_phone: t.phone });
    }
  }

  return res.status(200).json({ ready, missing, total_active: data?.length || 0 });
}

async function jobs(req, res, db, auth) {
  const { data: biz } = await db.from('businesses').select('timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const reDate = /^\d{4}-\d{2}-\d{2}$/;

  // Range mode: from/to (inclusive) span multiple days for the week view.
  const from = reDate.test((req.query.from || '').toString()) ? req.query.from : null;
  const to = reDate.test((req.query.to || '').toString()) ? req.query.to : null;
  // Single-date mode: date (default today).
  const dateStr = reDate.test((req.query.date || '').toString()) ? req.query.date : null;

  // Window is computed from explicit calendar dates so it never drifts when the
  // server's UTC day differs from the business's local day.
  let lo, hi;
  if (from && to) {
    lo = localDateStartUTC(tz, from);
    hi = localDateStartUTC(tz, addDaysStr(to, 1));
  } else if (dateStr) {
    lo = localDateStartUTC(tz, dateStr);
    hi = localDateStartUTC(tz, addDaysStr(dateStr, 1));
  } else {
    lo = localDayStartUTC(tz, 0);
    hi = localDayStartUTC(tz, 1);
  }

  // Scoped to jobs this tech is on (primary OR second tech) and NOT by business,
  // so cross-company jobs — booked by the partner company but worked by this
  // tech — show in their own app. No question about who they're working for.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes,
             address_line1, address_line2, city, state, postal_code, lat, lng, business_id,
             customer:customers ( name, phone ),
             service:services ( name ),
             business:businesses ( name, timezone ),
             line_items:booking_line_items ( name, kind )`), auth)
    .neq('status', 'cancelled')
    .gte('scheduled_at', lo.toISOString())
    .lt('scheduled_at', hi.toISOString())
    .order('scheduled_at', { ascending: true });
  const { data, error } = await fetchMine(build);
  if (error) throw error;

  // Attach the business-timezone calendar date so the app groups jobs by the
  // SAME day the dashboard does — using each job's OWN business tz so a
  // cross-company job lands on the right day. Flag cross-company jobs + the
  // company they're for so the app can make it unmistakable.
  const jobs = (data || []).map(b => {
    const j = shapeJob(b);
    const jbtz = b.business?.timezone || tz;
    j.local_date = localDateInTz(jbtz, j.scheduled_at);
    j.cross_company = !!(b.business_id && b.business_id !== auth.business_id);
    j.company_name = b.business?.name || null;
    return j;
  });
  return res.status(200).json({ jobs, tz });
}

// Business-timezone calendar date ('YYYY-MM-DD') for an instant.
function localDateInTz(tz, iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// Diagnostic: surfaces who the token says we are vs. what bookings actually
// exist, so a tech who sees no jobs can tell us whether it's an ID/business
// mismatch, a date problem, or a status filter. Read-only, scoped to the
// logged-in tech's own business.
async function debugIdentity(req, res, db, auth) {
  const { data: biz } = await db.from('businesses')
    .select('slug, name, timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const { data: me } = await db.from('technicians')
    .select('id, name, business_id, status').eq('id', auth.tech_id).single();

  // Bookings whose technician_id equals my login id — across ALL dates/statuses.
  const { data: mine } = await db.from('bookings')
    .select('id, status, scheduled_at, business_id')
    .eq('technician_id', auth.tech_id)
    .order('scheduled_at', { ascending: false }).limit(20);

  // Every recent booking in my business (any tech) so we can see what the
  // dashboard sees and compare technician_id / business_id.
  const { data: bizBookings } = await db.from('bookings')
    .select('id, status, scheduled_at, business_id, technician_id, technician:technicians!technician_id ( name )')
    .eq('business_id', auth.business_id)
    .order('scheduled_at', { ascending: false }).limit(20);

  // Run the EXACT same window + query that jobs() uses for the current week,
  // so we can see whether the date filter is what hides assigned jobs.
  const todayLocal = localDateInTz(tz, new Date().toISOString());
  const dow = new Date(todayLocal + 'T12:00:00Z').getUTCDay();
  const weekFrom = addDaysStr(todayLocal, -dow);
  const weekTo = addDaysStr(weekFrom, 6);
  const lo = localDateStartUTC(tz, weekFrom);
  const hi = localDateStartUTC(tz, addDaysStr(weekTo, 1));
  const { data: weekData, error: weekErr } = await db.from('bookings')
    .select('id, scheduled_at, status')
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .neq('status', 'cancelled')
    .gte('scheduled_at', lo.toISOString())
    .lt('scheduled_at', hi.toISOString());

  return res.status(200).json({
    you: {
      tech_id: auth.tech_id,
      tech_name: me?.name || null,
      token_business_id: auth.business_id,
      tech_record_business_id: me?.business_id || null,
      business_slug: biz?.slug || null,
      business_name: biz?.name || null,
      business_tz: tz,
    },
    week_test: {
      week_from: weekFrom, week_to: weekTo,
      window_lo: lo.toISOString(), window_hi: hi.toISOString(),
      jobs_found: (weekData || []).length,
      error: weekErr?.message || null,
    },
    assigned_to_you_count: (mine || []).length,
    assigned_to_you: (mine || []).map(b => ({
      id: b.id, status: b.status, scheduled_at: b.scheduled_at,
      local_date: localDateInTz(tz, b.scheduled_at),
    })),
    business_bookings_count: (bizBookings || []).length,
    business_bookings: (bizBookings || []).map(b => ({
      id: b.id, status: b.status, scheduled_at: b.scheduled_at,
      local_date: localDateInTz(tz, b.scheduled_at),
      business_id: b.business_id, technician_id: b.technician_id,
      assigned_tech_name: b.technician?.name || null,
      assigned_to_you: b.technician_id === auth.tech_id,
    })),
  });
}

async function job(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  // Primary OR second tech, any business, so a (cross-company) helper opens it.
  // The two technician embeds use explicit FK hints (technician_id /
  // secondary_technician_id) so PostgREST knows which relationship to follow.
  // The secondary embed is dropped on deployments predating migration 0019.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes, price,
             review_rating, review_text, reviewed_at, business_id, technician_id,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             payment_status, paid_at, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( name, phone, email ),
             service:services ( name ),
             business:businesses ( name ),
             technician:technicians!technician_id ( name ),${techHasSecondCol ? `
             secondary_technician_id,
             secondary_technician:technicians!secondary_technician_id ( name ),` : ''}
             line_items:booking_line_items ( name, quantity, unit_price, line_total, kind )`), auth)
    .eq('id', id)
    .maybeSingle();
  const { data, error } = await fetchMine(build);
  if (error || !data) return res.status(404).json({ error: 'Job not found' });
  const shaped = shapeJob(data, true, true);
  shaped.cross_company = !!(data.business_id && data.business_id !== auth.business_id);
  shaped.company_name = data.business?.name || null;
  // The OTHER technician on a two-person job (the partner the viewer works
  // alongside). If the viewer is the primary, that's the secondary tech; if
  // they're the secondary helper, it's the primary. Shown so each tech knows
  // who else is coming.
  const primaryName = data.technician?.name || null;
  const secondaryName = data.secondary_technician?.name || null;
  if (primaryName && secondaryName) {
    shaped.partner_tech = (data.technician_id === auth.tech_id) ? secondaryName : primaryName;
  } else {
    shaped.partner_tech = null;
  }
  return res.status(200).json({ job: shaped });
}

async function status(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  const next = (body.status || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const map = TECH_STATUS[next];
  if (!map) return res.status(400).json({ error: `Invalid status "${next}"` });

  // The job must belong to this tech — primary OR second tech — so a helper can
  // advance it too. All downstream writes use the job's OWN business_id, not the
  // tech's home business.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, scheduled_at, review_token, sms_consent, metadata, business_id, price, payment_status, business:businesses ( slug ), customer:customers ( name, phone, email )`), auth)
    .eq('id', id).maybeSingle();
  const { data: existing } = await fetchMine(build);
  if (!existing) return res.status(404).json({ error: 'Job not found' });
  const jobBizId = existing.business_id;

  // Gate completion on photo documentation (also enforced in the UI).
  if (next === 'completed') {
    const { count } = await db.from('booking_photos')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', id).eq('business_id', jobBizId);
    if ((count || 0) < MIN_PHOTOS_TO_COMPLETE) {
      return res.status(400).json({ error: `Add at least ${MIN_PHOTOS_TO_COMPLETE} photos before marking this job complete (${count || 0} so far).` });
    }
    // Gate completion on payment. Either tech can take the payment (card or cash),
    // but it must be collected before the job can be marked complete. Once paid,
    // the booking's shared payment_status reflects it for BOTH techs on the job.
    if (Number(existing.price) > 0 && existing.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Charge the card or take a cash payment before marking this job complete.' });
    }
  }

  const patch = { status: next };
  if (map.stamp) patch[map.stamp] = new Date().toISOString();

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id);
  if (e1) throw e1;

  await db.from('booking_status_events').insert({
    booking_id: id, business_id: jobBizId, technician_id: auth.tech_id,
    status: next, note: body.note || 'Updated by technician',
  });

  // Reflect availability in the admin dashboard.
  await db.from('technicians').update({ status: map.tech }).eq('id', auth.tech_id);

  // Send SMS to customer on certain status changes (if customer opted in).
  if (next === 'on_the_way' && existing.customer?.phone && existing.sms_consent) {
    const etaMinutes = body.eta_minutes || 30;
    const msg = `Your tech is on the way! ETA ${etaMinutes} minutes.`;
    sendSMS(existing.customer.phone, msg).catch(console.error);
  }

  // On completion: send the branded review-request email immediately, and an SMS
  // 20 minutes later (if the customer opted in). The tech app, not the dashboard,
  // is where jobs are normally completed — so this is the path that matters.
  if (next === 'completed' && existing.review_token) {
    console.log(`[review] job ${id} marked completed, review_token=${existing.review_token}, email=${existing.customer?.email}`);
    const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const reviewLink = `${baseUrl}/review.html?token=${encodeURIComponent(existing.review_token)}`;

    // Brand the email by the JOB's business (orange vs blue) — for a
    // cross-company job that's the host company, not the tech's own.
    const slug = existing.business?.slug || '';

    // Review email — sent right away, only once (tracked in metadata).
    if (existing.customer?.email) {
      if (existing.metadata?.review_email_sent_at) {
        console.log(`[review] email already sent at ${existing.metadata.review_email_sent_at}, skipping`);
      } else {
        try {
          const brand = brandFor(slug);
          const { subject, html } = reviewEmail({
            firstName: existing.customer.name || 'there',
            reviewUrl: reviewLink,
          }, brand);
          const { from } = emailConfig(slug);
          const emailResult = await sendEmail({ slug, to: existing.customer.email, subject, html, replyTo: from });
          if (emailResult.sent) {
            const newMeta = { ...(existing.metadata || {}), review_email_sent_at: new Date().toISOString() };
            await db.from('bookings').update({ metadata: newMeta }).eq('id', id);
            console.log(`[review] email sent to ${existing.customer.email} (${slug}) booking=${id}`);
          } else {
            console.warn(`[review] email NOT sent to ${existing.customer.email} (${slug}) booking=${id}:`, emailResult.skipped || emailResult.error);
          }
        } catch (e) {
          console.error(`[review] email failed for booking ${id}:`, e.message);
        }
      }
    } else {
      console.warn(`[review] no customer email on booking ${id}`);
    }

    // SMS reminder 20 minutes after completion (if customer opted in).
    if (existing.customer?.phone && existing.sms_consent) {
      const msg = `Your job is complete! How did we do? ${reviewLink}`;
      setTimeout(() => { sendSMS(existing.customer.phone, msg).catch(console.error); }, 20 * 60 * 1000);
    }
  } else if (next === 'completed') {
    console.log(`[review] job ${id} marked completed but no review_token`);
  }

  return res.status(200).json({ ok: true, status: next });
}

// ── Payment (techs can charge or mark-paid at service time) ────────────────────
async function jobPayment(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const act = (body.action || 'charge').toString();

  const build = () => scopeMine(db.from('bookings')
    .select(`id, price, payment_status, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             business:businesses ( slug ),
             customer:customers ( id, name, email, phone, stripe_customer_id )`), auth)
    .eq('id', id).maybeSingle();
  const { data: b, error } = await fetchMine(build);
  if (error || !b) return res.status(404).json({ error: 'Job not found' });

  // Charge/refund with THIS booking's business Stripe account (the card lives in
  // whichever account the booking belongs to — Doms cards aren't in HA's account).
  const slug = b.business?.slug || null;
  const now = new Date().toISOString();

  if (act === 'mark_paid') {
    await db.from('bookings').update({ payment_status: 'paid', paid_at: now, amount_paid: Number(b.price) || 0 }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'paid' });
  }
  if (act === 'mark_unpaid') {
    await db.from('bookings').update({ payment_status: 'unpaid', paid_at: null }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'unpaid' });
  }

  if (act === 'refund') {
    if (!b.stripe_payment_intent_id) return res.status(400).json({ error: 'No Stripe charge on this job to refund.' });
    try { await stripe('/refunds', { body: { payment_intent: b.stripe_payment_intent_id }, slug }); }
    catch (e) { return res.status(e.status || 402).json({ error: 'Refund failed: ' + e.message }); }
    await db.from('bookings').update({ payment_status: 'refunded', paid_at: null }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'refunded' });
  }

  if (act === 'charge') {
    if (!stripeConfigured(slug)) return res.status(400).json({ error: 'Payments are not configured on the server.' });
    const dollars = Number(b.price) || 0;
    if (dollars <= 0) return res.status(400).json({ error: 'Cannot charge for a job with no price.' });

    let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
    let pmId = b.stripe_payment_method_id || null;
    try {
      if (!custId && b.customer && b.customer.email) {
        const r = await findCardOnFileByEmail(b.customer.email, slug);
        custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
      }
      if (custId && !pmId) pmId = await defaultPaymentMethod(custId, slug);
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (!custId || !pmId) return res.status(400).json({ error: 'No card on file for this customer. Use "Mark paid (cash)" instead.' });

    let pi;
    try {
      pi = await stripe('/payment_intents', { slug, body: {
        amount: Math.round(dollars * 100), currency: 'usd',
        customer: custId, payment_method: pmId, off_session: true, confirm: true,
        description: `Job ${id}`, metadata: { job_id: id },
      }});
    } catch (e) {
      return res.status(e.status || 402).json({ error: 'Charge failed: ' + e.message });
    }
    if (pi.status !== 'succeeded') {
      return res.status(402).json({ error: `Charge not completed (status: ${pi.status}). The card may need the customer to re-authenticate.` });
    }

    await db.from('bookings').update({
      payment_status: 'paid', paid_at: now, amount_paid: dollars,
      stripe_payment_intent_id: pi.id, stripe_customer_id: custId, stripe_payment_method_id: pmId,
    }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'paid', amount: dollars, payment_intent_id: pi.id });
  }

  return res.status(400).json({ error: `Unknown payment action "${act}"` });
}

// ── Job photos (tech documents the job; 2 required before completing) ─────────
// Confirm a booking belongs to the logged-in tech before touching its photos/notes.
// Owned when this tech is the primary OR second tech (so a helper can add
// photos/notes too). Returns the job's OWN business_id, which callers use for
// those writes (never the tech's home business).
async function assertOwnedJob(db, auth, id) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const build = () => scopeMine(db.from('bookings').select('id, business_id'), auth).eq('id', id).maybeSingle();
  const { data } = await fetchMine(build);
  if (!data) { const e = new Error('Job not found'); e.status = 404; throw e; }
  return data.business_id;
}

async function jobPhotos(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_photos')
    .select('id, url, caption, uploader_name, created_at')
    .eq('booking_id', id).eq('business_id', bizId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return res.status(200).json({ photos: data || [], min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  let up;
  try { up = await uploadImage(body.image, `${bizId}/${id}`); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data, error } = await db.from('booking_photos').insert({
    business_id: bizId, booking_id: id, technician_id: auth.tech_id,
    uploaded_by_kind: 'technician', uploader_name: tech?.name || 'Technician',
    storage_path: up.path, url: up.url, caption: (body.caption || '').toString().trim() || null,
  }).select('id, url, caption, uploader_name, created_at').single();
  if (error) { await deleteImage(up.path); throw error; }

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ photo: data, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, photoId = body.photo_id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!photoId) return res.status(400).json({ error: 'photo_id required' });

  const { data: ph } = await db.from('booking_photos')
    .select('id, storage_path').eq('id', photoId).eq('booking_id', id).eq('business_id', bizId).single();
  if (!ph) return res.status(404).json({ error: 'Photo not found' });
  await db.from('booking_photos').delete().eq('id', photoId);
  await deleteImage(ph.storage_path);

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ ok: true, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

// ── Job notes (internal; tech can add/delete on their own jobs) ──────────────
async function jobNotes(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_notes')
    .select('id, body, author_kind, author_name, created_at')
    .eq('booking_id', id).eq('business_id', bizId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ notes: data || [] });
}

async function jobNoteAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const text = (body.body || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Note text required' });

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  const { data, error } = await db.from('booking_notes').insert({
    business_id: bizId, booking_id: id,
    author_kind: 'technician', author_id: auth.tech_id, author_name: tech?.name || 'Technician',
    body: text,
  }).select('id, body, author_kind, author_name, created_at').single();
  if (error) throw error;
  return res.status(200).json({ note: data });
}

async function jobNoteDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, noteId = body.note_id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!noteId) return res.status(400).json({ error: 'note_id required' });
  // Permanent delete (no soft-delete), scoped to this tech's job.
  await db.from('booking_notes').delete()
    .eq('id', noteId).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ ok: true });
}

// ── Weekly availability (the tech edits their OWN) ──────────────────────────
// Return this tech's selected slots plus the fixed slot/day definitions so the
// app renders the picker without hardcoding them.
async function getAvailability(req, res, db, auth) {
  const { data, error } = await db.from('technician_availability')
    .select('day_of_week, slot_key')
    .eq('technician_id', auth.tech_id);
  if (error) throw error;

  // Upcoming one-time exceptions (today onward) so the app can show & edit them.
  const today = new Date().toISOString().slice(0, 10);
  const { data: exc, error: e2 } = await db.from('technician_availability_exceptions')
    .select('exception_date, slot_key, is_available')
    .eq('technician_id', auth.tech_id)
    .gte('exception_date', today)
    .order('exception_date');
  if (e2) throw e2;

  return res.status(200).json({
    slots: SLOTS, days: DAYS,
    availability: (data || []).map(r => ({ day_of_week: r.day_of_week, slot_key: r.slot_key })),
    exceptions: (exc || []).map(r => ({ date: r.exception_date, slot_key: r.slot_key, is_available: r.is_available })),
  });
}

// Replace this tech's availability with the provided set (a full replace keeps
// the client simple and the state unambiguous). Only the five fixed slots on
// days 0–6 are accepted; anything else is rejected by normalizeSlots().
async function setAvailability(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let rows;
  try { rows = normalizeSlots(body.slots); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability').delete().eq('technician_id', auth.tech_id);
  if (rows.length) {
    const { error } = await db.from('technician_availability').insert(
      rows.map(r => ({ business_id: auth.business_id, technician_id: auth.tech_id, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, count: rows.length });
}

// Set a ONE-TIME override for a single date. The client sends the slot keys the
// tech will actually work that date; we store only the differences from their
// recurring schedule (so the weekly schedule is never touched). Sending a
// selection that matches the recurring schedule clears the date back to normal.
async function setAvailabilityException(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let date, rows;
  try {
    date = assertDate(body.date);
    const dow = dayOfWeekFor(date);
    const { data: recur, error } = await db.from('technician_availability')
      .select('slot_key').eq('technician_id', auth.tech_id).eq('day_of_week', dow);
    if (error) throw error;
    rows = computeExceptionRows((recur || []).map(r => r.slot_key), body.selected);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability_exceptions')
    .delete().eq('technician_id', auth.tech_id).eq('exception_date', date);
  if (rows.length) {
    const { error } = await db.from('technician_availability_exceptions').insert(
      rows.map(r => ({ business_id: auth.business_id, technician_id: auth.tech_id, exception_date: date, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, date, count: rows.length });
}

function shapeJob(b, full = false, forTech = false) {
  const address = [b.address_line1, b.address_line2, b.city, b.state, b.postal_code].filter(Boolean).join(', ');
  // Line items the tech should never see as "work" (fees, tips, coupons, and the
  // dismount up-sell which is a payment concern, not a task).
  const HIDDEN_LI = new Set(['Guaranteed Dismount Service']);
  const isHiddenLi = (li) => {
    const kind = li.kind || 'service';
    if (kind === 'fee' || kind === 'tip' || kind === 'coupon') return true;
    return HIDDEN_LI.has((li.name || '').trim());
  };
  // Service name: use the linked service only (TV Mounting, Handyman, etc).
  // Don't fall back to line item names—they're internal detail, not service categories.
  const serviceName = b.service?.name || null;
  const out = {
    id: b.id,
    status: b.status,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    customer_name: b.customer?.name || 'Customer',
    customer_phone: b.customer?.phone || null,
    service: serviceName,
    address,
    customer_notes: b.customer_notes || null,
    maps_url: address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null,
    lat: b.lat || null,
    lng: b.lng || null,
  };
  if (full) {
    out.customer_email = b.customer?.email || null;
    out.notes = b.notes || null;
    out.price = b.price;
    // Google Maps Street View Static API key (client-side, referrer-restricted).
    // Sent so the tech portal can render a Street View of the job location even
    // when lat/lng aren't stored (it can geocode the address string instead).
    out.maps_key = process.env.GOOGLE_MAPS_API_KEY || null;
    // For techs, only show work items; hide fees, tips, coupons, and dismount.
    out.line_items = (b.line_items || []).filter(li => forTech ? !isHiddenLi(li) : true);
    out.payment_status = b.payment_status || 'unpaid';
    out.paid_at = b.paid_at || null;
    out.stripe_customer_id = b.stripe_customer_id || null;
    out.stripe_payment_method_id = b.stripe_payment_method_id || null;
    out.stripe_payment_intent_id = b.stripe_payment_intent_id || null;
    // Customer review for this job (so the tech sees the rating + comment in context).
    out.review_rating = b.review_rating || null;
    out.review_text = b.review_text || null;
    out.reviewed_at = b.reviewed_at || null;
  }
  return out;
}

// ── Payroll Report ─────────────────────────────────────────────────────────
// Tech pay for one Sun–Sat week, computed from the rate sheet (api/_lib/payroll.js).
// Jobs are bucketed: paid (counted this week), deferred (unpaid — future week),
// or flagged (computed but needs owner review). Pay date = period-end Sat + 15d.
async function techPayroll(req, res, db, auth) {
  const weekStart = (req.query.week_start || '').toString();
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: 'week_start (YYYY-MM-DD, Sunday) required' });
  }

  const techId = auth.tech_id;
  const weekEnd = addDaysStr(weekStart, 6);

  // The tech's business slug drives Dom's-vs-HA handling inside the engine.
  const { data: techRow } = await db.from('technicians')
    .select('name, businesses(slug)').eq('id', techId).single();
  const techName = techRow?.name || '';
  const businessSlug = techRow?.businesses?.slug || '';

  // Completed jobs for this tech in the week, with everything the engine needs.
  const { data: jobs, error } = await db.from('bookings')
    .select(`
      id, scheduled_at, status, subtotal, price, payment_status, amount_paid,
      tip, notes, customer_notes, zenbooker_job_number,
      customers(name), services(name),
      line_items:booking_line_items(kind, name, unit_price, line_total)
    `)
    .eq('technician_id', techId)
    .eq('status', 'completed')
    .gte('scheduled_at', weekStart + 'T00:00:00Z')
    .lte('scheduled_at', weekEnd + 'T23:59:59Z')
    .order('scheduled_at');

  if (error) throw error;

  const paidJobs = [];
  const deferredJobs = [];
  let totalPay = 0;

  for (const b of jobs || []) {
    const result = computeJobPay({
      status: b.status,
      payment_status: b.payment_status,
      price: b.price,
      subtotal: b.subtotal,
      amount_paid: b.amount_paid,
      tip: b.tip,
      notes: b.notes,
      customer_notes: b.customer_notes,
      zenbooker_job_number: b.zenbooker_job_number,
      service_name: b.services?.name || '',
      business_slug: businessSlug,
      line_items: b.line_items || [],
    }, techName);

    const base = {
      id: b.id,
      customer_name: b.customers?.name || 'Unknown',
      service: b.services?.name || 'Service',
      time: new Date(b.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    };

    if (result.state === 'deferred') {
      deferredJobs.push({ ...base, customer_due: Math.floor((Number(b.price) || 0) - (Number(b.amount_paid) || 0)) });
    } else if (result.state === 'excluded') {
      // not paid, not shown
    } else {
      paidJobs.push({
        ...base,
        tech_pay: result.pay,
        breakdown: result.breakdown,
        flags: result.flags,
        needs_review: result.flags.length > 0 || result.state === 'partial',
      });
      totalPay += result.pay;
    }
  }

  return res.status(200).json({
    week_start: weekStart,
    week_end: weekEnd,
    pay_date: addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS),
    tech_name: techName,
    jobs: paidJobs,
    deferred: deferredJobs,
    total: totalPay,
  });
}

// ── Reviews Report ───────────────────────────────────────────────────────────
// The customer reviews this tech has earned: all-time average + count, how many
// landed this week (business-tz Sun–Sat), and a recent list. Each review carries
// the star rating, the customer's comment, and which job/service it was for.
// Reviews live on bookings (review_rating 1-5, review_text, reviewed_at).
async function techReviews(req, res, db, auth) {
  const { data: biz } = await db.from('businesses').select('timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const weekStartMs = startOfWeekUTC(tz).getTime();

  // technician_id alone so reviews earned on cross-company jobs count too.
  const { data, error } = await db.from('bookings')
    .select(`id, scheduled_at, reviewed_at, review_rating, review_text,
             customer:customers ( name ),
             service:services ( name )`)
    .eq('technician_id', auth.tech_id)
    .not('review_rating', 'is', null)
    .order('reviewed_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw error;

  const all = data || [];
  const total = all.length;
  const sum = all.reduce((a, r) => a + (Number(r.review_rating) || 0), 0);
  const average = total ? Math.round((sum / total) * 10) / 10 : 0;

  let weekCount = 0;
  const reviews = all.map(r => {
    // reviewed_at can be null for reviews imported without a timestamp; those
    // simply don't count toward "this week".
    const ts = r.reviewed_at ? new Date(r.reviewed_at).getTime() : 0;
    const this_week = ts >= weekStartMs;
    if (this_week) weekCount++;
    return {
      id: r.id,
      rating: r.review_rating,
      text: r.review_text || '',
      service: r.service?.name || null,
      customer_name: r.customer?.name || 'Customer',
      reviewed_at: r.reviewed_at,
      scheduled_at: r.scheduled_at,
      this_week,
    };
  });

  return res.status(200).json({ average, total, week_count: weekCount, reviews });
}

// ── Bracket inventory (read-only) ────────────────────────────────────────────
// The logged-in tech's own bracket stock (flat / tilting / full motion). Techs
// can SEE their count but NOT change it — only the owner edits counts (admin
// dashboard) and assigns deliveries. The tech id comes from the signed token,
// never the request, so a tech can only ever read their OWN inventory.
async function bracketInventory(req, res, db, auth) {
  const { data: inv, error } = await db.from('bracket_inventory')
    .select('flat_qty, tilting_qty, full_motion_qty, updated_at')
    .eq('technician_id', auth.tech_id)
    .eq('business_id', auth.business_id)
    .maybeSingle();
  if (error) throw error;

  const flat = inv?.flat_qty || 0;
  const tilting = inv?.tilting_qty || 0;
  const full_motion = inv?.full_motion_qty || 0;
  return res.status(200).json({
    flat,
    tilting,
    full_motion,
    total: flat + tilting + full_motion,
    updated_at: inv?.updated_at || null,
  });
}
