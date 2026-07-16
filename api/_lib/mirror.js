// Best-effort mirror of a freshly-created Zenbooker job into the Supabase
// system-of-record, so the admin dashboard reflects NEW bookings in real time
// (before/without a full historical import).
//
// CONTRACT: this must NEVER break a booking. It swallows every error, and it
// no-ops silently when SUPABASE_SERVICE_ROLE_KEY isn't configured. Price/time
// are read from whatever the Zenbooker response provides and reconcile later
// via scripts/import-zenbooker.mjs.
import { serviceClient } from './supabase.js';
import { signToken } from './auth.js';

function first(...vals) { for (const v of vals) if (v != null && v !== '') return v; return null; }

// True only for a violation of bookings_tech_slot_unique (migration 0073) —
// two concurrent bookings landed on the same tech's same exact slot. Checked
// by index name specifically so it's never confused with the idempotency_key
// uniqueness check just below, which is a different constraint and needs
// completely different handling (return the EXISTING booking, not retry).
function isTechSlotRaceErr(e) { return !!(e && e.code === '23505' && /bookings_tech_slot_unique/.test(e.message || '')); }

export async function mirrorBooking(ctx = {}) {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    const db = serviceClient();
    const job = ctx.zbkJob || {};

    const { data: biz } = await db.from('businesses').select('id, name, slug, timezone').eq('slug', ctx.businessSlug).single();
    if (!biz) return;

    // Service area from the Zenbooker territory.
    let service_area_id = null;
    if (ctx.territory_id) {
      const { data: area } = await db.from('service_areas')
        .select('id').eq('business_id', biz.id)
        .eq('zenbooker_territory_id', String(ctx.territory_id)).maybeSingle();
      service_area_id = area?.id || null;
    }

    // Technician: an explicit CRM technician_id wins (native bookings already
    // know who they assigned); else resolve by provider id, then by name.
    const assigned = (job.assigned_providers || job.providers || [])[0] || {};
    const providerName = first(ctx.technician_name, assigned.name, assigned.display_name);
    let technician_id = ctx.technician_id || null;
    const providerId = first(ctx.technician_provider_id, assigned.id, assigned.provider_id);
    if (!technician_id && providerId) {
      const { data: t } = await db.from('technicians').select('id')
        .eq('business_id', biz.id).eq('zenbooker_provider_id', String(providerId)).maybeSingle();
      technician_id = t?.id || null;
    }
    if (!technician_id && providerName) {
      const { data: t } = await db.from('technicians').select('id')
        .eq('business_id', biz.id).ilike('name', `%${providerName.split(' ')[0]}%`).maybeSingle();
      technician_id = t?.id || null;
    }

    // Default service by name.
    let service_id = null;
    if (ctx.service_name) {
      const { data: s } = await db.from('services').select('id')
        .eq('business_id', biz.id).ilike('name', ctx.service_name).maybeSingle();
      service_id = s?.id || null;
    }

    // Customer: upsert by zenbooker id, else dedupe by email, else insert.
    const c = ctx.customer || {};
    const a = ctx.address || {};
    const custRow = {
      business_id: biz.id,
      name: first(c.name, `${c.first_name || ''} ${c.last_name || ''}`.trim(), 'Customer'),
      first_name: c.first_name || null, last_name: c.last_name || null,
      phone: c.phone || null, email: c.email || null,
      address_line1: a.line1 || null, address_line2: a.line2 || null, city: a.city || null, state: a.state || null, postal_code: a.postal_code || null,
      stripe_customer_id: ctx.stripe_customer_id || null,
      zenbooker_customer_id: ctx.zenbooker_customer_id ? String(ctx.zenbooker_customer_id) : null,
    };
    let customer_id = null;
    if (custRow.zenbooker_customer_id) {
      const { data } = await db.from('customers')
        .upsert(custRow, { onConflict: 'business_id,zenbooker_customer_id' }).select('id').single();
      customer_id = data?.id || null;
    } else if (custRow.email) {
      const { data: found } = await db.from('customers').select('id')
        .eq('business_id', biz.id).eq('email', custRow.email).maybeSingle();
      customer_id = found?.id || (await db.from('customers').insert(custRow).select('id').single()).data?.id || null;
    } else {
      customer_id = (await db.from('customers').insert(custRow).select('id').single()).data?.id || null;
    }
    if (!customer_id) return;

    // Booking: upsert by zenbooker job id.
    const scheduled_at = first(ctx.scheduled_at, job.start_time, job.scheduled_at, job.starts_at, job.start,
                               job.appointment && job.appointment.start_time);
    const price = Number(first(ctx.price, job.total, job.price, job.amount, 0)) || 0;

    const bookingRow = {
      business_id: biz.id, customer_id, technician_id, service_id,
      // Native callers (no Zenbooker territory) can pass service_area_id directly;
      // Zenbooker callers keep resolving it from the territory id above.
      service_area_id: ctx.service_area_id || service_area_id,
      status: ctx.status || (technician_id ? 'assigned' : 'confirmed'),
      source: ctx.source || 'widget',
      scheduled_at: scheduled_at || null,
      // Optional, additive — only set when the caller provides them so existing
      // Zenbooker mirrors are byte-for-byte unchanged.
      ...(ctx.scheduled_end ? { scheduled_end: ctx.scheduled_end } : {}),
      ...(ctx.duration_minutes ? { duration_minutes: Number(ctx.duration_minutes) } : {}),
      ...(ctx.subtotal != null ? { subtotal: Number(ctx.subtotal) || 0 } : {}),
      ...(ctx.payment_status ? { payment_status: ctx.payment_status } : {}),
      ...(ctx.stripe_customer_id ? { stripe_customer_id: ctx.stripe_customer_id } : {}),
      ...(ctx.stripe_payment_method_id ? { stripe_payment_method_id: ctx.stripe_payment_method_id } : {}),
      // Which Stripe account the card was saved in, so charges later pick the
      // right key. Only set when the caller stamps it (native paths); Zenbooker
      // mirrors leave it NULL = legacy global/slug behavior.
      ...(ctx.stripe_account ? { stripe_account: ctx.stripe_account } : {}),
      price, tip: Number(ctx.tip) || 0,
      address_line1: a.line1 || null, address_line2: a.line2 || null, city: a.city || null, state: a.state || null, postal_code: a.postal_code || null,
      notes: first(ctx.notes, providerName && `Zenbooker tech: ${providerName}`),
      customer_notes: ctx.customer_notes || null,
      zenbooker_job_id: ctx.zenbooker_job_id ? String(ctx.zenbooker_job_id) : null,
      zenbooker_job_number: job.job_number ? String(job.job_number) : null,
      metadata: { mirrored_at: new Date().toISOString(), source: ctx.source || 'widget' },
    };
    let booking_id = null;
    let hadReviewToken = false;
    if (bookingRow.zenbooker_job_id) {
      // Never let a re-mirror move a booking BACKWARD. If a row already exists for
      // this zenbooker_job_id and the CRM has advanced it, don't downgrade status
      // or replace metadata (which would wipe review_email_sent_at).
      const { data: prev } = await db.from('bookings')
        .select('id, status, completed_at, metadata, review_token')
        .eq('business_id', biz.id).eq('zenbooker_job_id', bookingRow.zenbooker_job_id).maybeSingle();
      if (prev && (['completed', 'cancelled', 'no_show'].includes(prev.status) || prev.completed_at)) {
        // Terminal in the CRM — leave the booking exactly as-is.
        return { booking_id: prev.id, customer_id, business_id: biz.id, technician_id };
      }
      if (prev) {
        delete bookingRow.status;                                              // keep the CRM's in-progress status
        bookingRow.metadata = { ...(prev.metadata || {}), ...bookingRow.metadata }; // merge, preserve prior stamps
        hadReviewToken = !!prev.review_token;
      }
      let up = await db.from('bookings')
        .upsert(bookingRow, { onConflict: 'business_id,zenbooker_job_id' }).select('id').single();
      if (isTechSlotRaceErr(up.error)) {
        // Same tech/slot race handling as the two insert branches below — a
        // Zenbooker job whose auto-assigned tech collides with an existing
        // non-cancelled booking at that instant (bookings_tech_slot_unique)
        // must fall back to unassigned, not silently lose the mirror (the
        // upsert's error was previously discarded entirely, so this branch
        // was the one place the 0073 index could eat a booking).
        console.warn('[mirror] tech/slot race lost (zenbooker upsert), booking unassigned instead:', up.error.message);
        technician_id = null;
        bookingRow.technician_id = null;
        if (bookingRow.status === 'assigned') bookingRow.status = 'confirmed';
        up = await db.from('bookings')
          .upsert(bookingRow, { onConflict: 'business_id,zenbooker_job_id' }).select('id').single();
      }
      booking_id = up.data?.id || null;
    } else if (ctx.idempotency_key) {
      // Native bookings: a retried submit (same key) must not duplicate. The
      // idempotency index is PARTIAL (…WHERE idempotency_key IS NOT NULL), which
      // can't be an upsert arbiter — so insert and, on the unique violation,
      // return the existing booking instead (and skip re-writing line items).
      bookingRow.idempotency_key = String(ctx.idempotency_key);
      let ins = await db.from('bookings').insert(bookingRow).select('id').single();
      if (isTechSlotRaceErr(ins.error)) {
        // A DIFFERENT customer's booking landed on this exact tech+slot first
        // (see bookings_tech_slot_unique, migration 0073) — not a retry of
        // THIS customer's own submit, so the idempotency-duplicate branch
        // below is the wrong handling. Fall back to unassigned rather than
        // losing the booking or double-booking the tech; the office assigns
        // manually. Downstream callers (book.js) compare the returned
        // technician_id against what they originally picked so a "meet your
        // tech" confirmation email never names a tech who isn't actually on
        // the job.
        console.warn('[mirror] tech/slot race lost, booking unassigned instead:', ins.error.message);
        technician_id = null;
        bookingRow.technician_id = null;
        if (bookingRow.status === 'assigned') bookingRow.status = 'confirmed';
        ins = await db.from('bookings').insert(bookingRow).select('id').single();
      }
      if (!ins.error) {
        booking_id = ins.data?.id || null;
      } else if (ins.error.code === '23505' || /duplicate key|idempotency/i.test(ins.error.message || '')) {
        const { data: existing } = await db.from('bookings').select('id')
          .eq('business_id', biz.id).eq('idempotency_key', String(ctx.idempotency_key)).maybeSingle();
        if (existing?.id) return { booking_id: existing.id, customer_id, business_id: biz.id, technician_id, duplicate: true };
        return;
      } else if (/idempotency_key/.test(ins.error.message || '')) {
        // DB predates migration 0024 (no idempotency_key column) — insert without it.
        delete bookingRow.idempotency_key;
        booking_id = (await db.from('bookings').insert(bookingRow).select('id').single()).data?.id || null;
      } else {
        return;   // best-effort: swallow
      }
    } else {
      let ins = await db.from('bookings').insert(bookingRow).select('id').single();
      if (isTechSlotRaceErr(ins.error)) {
        console.warn('[mirror] tech/slot race lost, booking unassigned instead:', ins.error.message);
        technician_id = null;
        bookingRow.technician_id = null;
        if (bookingRow.status === 'assigned') bookingRow.status = 'confirmed';
        ins = await db.from('bookings').insert(bookingRow).select('id').single();
      }
      booking_id = ins.data?.id || null;
    }
    if (!booking_id) return;

    // Generate a review token with the now-known booking_id (30-day TTL: 2592000
    // seconds) — but only if the booking doesn't already have one, so a re-mirror
    // never invalidates a review link that was already emailed to the customer.
    if (!hadReviewToken) {
      const reviewToken = signToken({ booking_id }, 2592000);
      await db.from('bookings').update({ review_token: reviewToken }).eq('id', booking_id);
    }

    // Line items (replace any prior mirror for this booking).
    const lines = Array.isArray(ctx.line_items) ? ctx.line_items.filter(Boolean) : [];
    if (lines.length) {
      await db.from('booking_line_items').delete().eq('booking_id', booking_id);
      await db.from('booking_line_items').insert(lines.map(li => ({
        booking_id, business_id: biz.id,
        kind: li.kind || 'service', name: String(li.name || 'Item').slice(0, 200),
        quantity: Number(li.quantity) || 1,
        unit_price: Number(li.unit_price) || 0,
        line_total: Number(li.line_total != null ? li.line_total : li.unit_price) || 0,
      })));
    }

    await db.from('booking_status_events').insert({
      booking_id, business_id: biz.id, technician_id,
      status: bookingRow.status, note: `Mirrored from ${ctx.source || 'widget'} booking`,
    });

    // Note: online (widget) bookings no longer send Heather/Joey a "someone just
    // booked" email — per owner request, that heads-up email is only sent for
    // ESTIMATE requests now (see sendOwnerEstimateAlert in api/estimate.js).

    // Native callers (e.g. the Doms widget) need the new row's id to confirm /
    // email the booking. Zenbooker callers ignore the return value.
    return { booking_id, customer_id, business_id: biz.id, technician_id };
  } catch (e) {
    console.warn('[mirror] non-fatal:', e.message);
  }
}
