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
import { localDayStartUTC, localDateStartUTC, addDaysStr } from './_lib/time.js';
import { SLOTS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows } from './_lib/availability.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod } from './_lib/stripe.js';
import { uploadImage, deleteImage } from './_lib/storage.js';

// A job is not "complete" until the tech has documented it with photos.
const MIN_PHOTOS_TO_COMPLETE = 2;

// ── SMS Helper ──────────────────────────────────────────────────────────────
async function sendSMS(phoneNumber, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('[SMS] Twilio not configured; message not sent:', message);
    return;
  }
  const formData = new URLSearchParams();
  formData.append('From', process.env.TWILIO_PHONE_NUMBER);
  formData.append('To', phoneNumber);
  formData.append('Body', message);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}` },
      body: formData,
    });
    if (!res.ok) throw new Error(`Twilio error: ${res.status}`);
    console.log('[SMS] Sent to', phoneNumber.slice(-4));
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
      case 'debug_identity':   return await debugIdentity(req, res, db, auth);
      default:                 return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[tech]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function login(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const phone = (body.phone || '').toString().trim();
  const pin = (body.pin || '').toString().trim();
  if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

  const db = serviceClient();
  // Verify against the hashed PIN inside the DB; the hash never leaves Postgres.
  const { data, error } = await db.rpc('verify_technician_pin', { p_phone: phone, p_pin: pin });
  if (error) throw error;
  const tech = Array.isArray(data) ? data[0] : data;
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
  // Always allow dev bypass in development (no TECH_DEV_BYPASS env var needed)
  return true;
}

// List every technician (with business) so the dev login screen can pick one.
async function devTechs(req, res) {
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

  const { data, error } = await db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             customer:customers ( name, phone ),
             service:services ( name )`)
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .neq('status', 'canceled')
    .gte('scheduled_at', lo.toISOString())
    .lt('scheduled_at', hi.toISOString())
    .order('scheduled_at', { ascending: true });
  if (error) throw error;

  // Attach the business-timezone calendar date so the app groups jobs by the
  // SAME day the dashboard does — regardless of the technician's device tz.
  const jobs = (data || []).map(shapeJob).map(j => ({ ...j, local_date: localDateInTz(tz, j.scheduled_at) }));
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
    .select('id, status, scheduled_at, business_id, technician_id, technician:technicians ( name )')
    .eq('business_id', auth.business_id)
    .order('scheduled_at', { ascending: false }).limit(20);

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
    assigned_to_you_count: (mine || []).length,
    assigned_to_you: mine || [],
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
  const { data, error } = await db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes, price,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             payment_status, paid_at, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( name, phone, email ),
             service:services ( name ),
             line_items:booking_line_items ( name, quantity, unit_price, line_total, kind )`)
    .eq('id', id)
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Job not found' });
  return res.status(200).json({ job: shapeJob(data, true, true) });
}

async function status(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  const next = (body.status || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const map = TECH_STATUS[next];
  if (!map) return res.status(400).json({ error: `Invalid status "${next}"` });

  // The job must belong to this tech.
  const { data: existing } = await db.from('bookings')
    .select(`id, scheduled_at, review_token, customer:customers ( name, phone )`).eq('id', id).eq('business_id', auth.business_id).eq('technician_id', auth.tech_id).single();
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  // Gate completion on photo documentation (also enforced in the UI).
  if (next === 'completed') {
    const { count } = await db.from('booking_photos')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', id).eq('business_id', auth.business_id);
    if ((count || 0) < MIN_PHOTOS_TO_COMPLETE) {
      return res.status(400).json({ error: `Add at least ${MIN_PHOTOS_TO_COMPLETE} photos before marking this job complete (${count || 0} so far).` });
    }
  }

  const patch = { status: next };
  if (map.stamp) patch[map.stamp] = new Date().toISOString();

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id);
  if (e1) throw e1;

  await db.from('booking_status_events').insert({
    booking_id: id, business_id: auth.business_id, technician_id: auth.tech_id,
    status: next, note: body.note || 'Updated by technician',
  });

  // Reflect availability in the admin dashboard.
  await db.from('technicians').update({ status: map.tech }).eq('id', auth.tech_id);

  // Send SMS to customer on certain status changes.
  if (next === 'on_the_way' && existing.customer?.phone) {
    const etaMinutes = body.eta_minutes || 30;
    const msg = `Your tech is on the way! ETA ${etaMinutes} minutes.`;
    sendSMS(existing.customer.phone, msg).catch(console.error);
  }
  if (next === 'completed' && existing.customer?.phone && existing.review_token) {
    const reviewLink = `${process.env.VERCEL_URL || 'http://localhost:3000'}/review.html?token=${encodeURIComponent(existing.review_token)}`;
    const msg = `Your job is complete! How did we do? ${reviewLink}`;
    sendSMS(existing.customer.phone, msg).catch(console.error);
  }

  return res.status(200).json({ ok: true, status: next });
}

// ── Payment (techs can charge or mark-paid at service time) ────────────────────
async function jobPayment(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const act = (body.action || 'charge').toString();

  const { data: b, error } = await db.from('bookings')
    .select(`id, price, payment_status, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( id, name, email, phone, stripe_customer_id )`)
    .eq('id', id).eq('business_id', auth.business_id).eq('technician_id', auth.tech_id).single();
  if (error || !b) return res.status(404).json({ error: 'Job not found' });

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
    try { await stripe('/refunds', { body: { payment_intent: b.stripe_payment_intent_id } }); }
    catch (e) { return res.status(e.status || 402).json({ error: 'Refund failed: ' + e.message }); }
    await db.from('bookings').update({ payment_status: 'refunded', paid_at: null }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'refunded' });
  }

  if (act === 'charge') {
    if (!stripeConfigured()) return res.status(400).json({ error: 'Payments are not configured on the server.' });
    const dollars = Number(b.price) || 0;
    if (dollars <= 0) return res.status(400).json({ error: 'Cannot charge for a job with no price.' });

    let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
    let pmId = b.stripe_payment_method_id || null;
    try {
      if (!custId && b.customer && b.customer.email) {
        const r = await findCardOnFileByEmail(b.customer.email);
        custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
      }
      if (custId && !pmId) pmId = await defaultPaymentMethod(custId);
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (!custId || !pmId) return res.status(400).json({ error: 'No card on file for this customer. Use "Mark paid (cash)" instead.' });

    let pi;
    try {
      pi = await stripe('/payment_intents', { body: {
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
async function assertOwnedJob(db, auth, id) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data } = await db.from('bookings')
    .select('id').eq('id', id).eq('business_id', auth.business_id).eq('technician_id', auth.tech_id).single();
  if (!data) { const e = new Error('Job not found'); e.status = 404; throw e; }
}

async function jobPhotos(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_photos')
    .select('id, url, caption, uploader_name, created_at')
    .eq('booking_id', id).eq('business_id', auth.business_id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return res.status(200).json({ photos: data || [], min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  let up;
  try { up = await uploadImage(body.image, `${auth.business_id}/${id}`); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data, error } = await db.from('booking_photos').insert({
    business_id: auth.business_id, booking_id: id, technician_id: auth.tech_id,
    uploaded_by_kind: 'technician', uploader_name: tech?.name || 'Technician',
    storage_path: up.path, url: up.url, caption: (body.caption || '').toString().trim() || null,
  }).select('id, url, caption, uploader_name, created_at').single();
  if (error) { await deleteImage(up.path); throw error; }

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', auth.business_id);
  return res.status(200).json({ photo: data, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, photoId = body.photo_id;
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!photoId) return res.status(400).json({ error: 'photo_id required' });

  const { data: ph } = await db.from('booking_photos')
    .select('id, storage_path').eq('id', photoId).eq('booking_id', id).eq('business_id', auth.business_id).single();
  if (!ph) return res.status(404).json({ error: 'Photo not found' });
  await db.from('booking_photos').delete().eq('id', photoId);
  await deleteImage(ph.storage_path);

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', auth.business_id);
  return res.status(200).json({ ok: true, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

// ── Job notes (internal; tech can add/delete on their own jobs) ──────────────
async function jobNotes(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_notes')
    .select('id, body, author_kind, author_name, created_at')
    .eq('booking_id', id).eq('business_id', auth.business_id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ notes: data || [] });
}

async function jobNoteAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const text = (body.body || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Note text required' });

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  const { data, error } = await db.from('booking_notes').insert({
    business_id: auth.business_id, booking_id: id,
    author_kind: 'technician', author_id: auth.tech_id, author_name: tech?.name || 'Technician',
    body: text,
  }).select('id, body, author_kind, author_name, created_at').single();
  if (error) throw error;
  return res.status(200).json({ note: data });
}

async function jobNoteDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, noteId = body.note_id;
  try { await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!noteId) return res.status(400).json({ error: 'note_id required' });
  // Permanent delete (no soft-delete), scoped to this tech's job.
  await db.from('booking_notes').delete()
    .eq('id', noteId).eq('booking_id', id).eq('business_id', auth.business_id);
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
  const out = {
    id: b.id,
    status: b.status,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    customer_name: b.customer?.name || 'Customer',
    customer_phone: b.customer?.phone || null,
    service: b.service?.name || null,
    address,
    customer_notes: b.customer_notes || null,
    maps_url: address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null,
  };
  if (full) {
    out.customer_email = b.customer?.email || null;
    out.notes = b.notes || null;
    out.price = b.price;
    // For techs, hide tax and dismount line items
    out.line_items = (b.line_items || []).filter(li =>
      forTech ? li.kind !== 'fee' && li.name !== 'Guaranteed Dismount Service' : true
    );
    out.payment_status = b.payment_status || 'unpaid';
    out.paid_at = b.paid_at || null;
    out.stripe_customer_id = b.stripe_customer_id || null;
    out.stripe_payment_method_id = b.stripe_payment_method_id || null;
    out.stripe_payment_intent_id = b.stripe_payment_intent_id || null;
  }
  return out;
}
