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
import { emailConfig, sendEmail } from './email.js';
import { emailNotificationsOn } from './notify.js';

function first(...vals) { for (const v of vals) if (v != null && v !== '') return v; return null; }
function escHtml(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Owner heads-up: a short email to the owner whenever a CUSTOMER books through a
// widget (source 'widget'). Best-effort — wrapped in try/catch so it can never
// break a booking. Recipient defaults to Andrew; override with OWNER_NOTIFY_EMAIL.
async function notifyOwnerNewBooking({ biz, ctx, booking_id, scheduled_at, price, providerName }) {
  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(ctx.businessSlug);
    if (!cfg.apiKey) return;
    const to = process.env.OWNER_NOTIFY_EMAIL || 'andrewtrading04@gmail.com';
    const c = ctx.customer || {}, a = ctx.address || {};
    const tz = biz.timezone || 'America/Denver';
    const money = (n) => '$' + (Number(n) || 0).toFixed(2);
    let when = '';
    if (scheduled_at) {
      try {
        const d = new Date(scheduled_at);
        const datePart = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        let timePart = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        if (ctx.scheduled_end) timePart += ' – ' + new Date(ctx.scheduled_end).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        when = `${datePart} · ${timePart}`;
      } catch (_) { when = String(scheduled_at); }
    }
    const name = first(c.name, `${c.first_name || ''} ${c.last_name || ''}`.trim(), 'Customer');
    const addr = [a.line1, a.city, a.state, a.postal_code].filter(Boolean).join(', ');
    const rows = [
      ['Company', biz.name || ctx.businessSlug],
      ['Customer', name], ['Phone', c.phone], ['Email', c.email],
      ['Address', addr], ['Service', ctx.service_name], ['When', when],
      ['Technician', providerName || 'Unassigned'], ['Total', money(price)],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const items = (Array.isArray(ctx.line_items) ? ctx.line_items : []).filter(Boolean)
      .map(li => `<tr><td style="padding:2px 10px 2px 0;">${escHtml(li.name || 'Item')}${(Number(li.quantity) || 1) > 1 ? ` ×${li.quantity}` : ''}</td><td style="padding:2px 0;text-align:right;">${money(li.line_total != null ? li.line_total : li.unit_price)}</td></tr>`).join('');
    const notes = ctx.customer_notes ? `<p style="margin:14px 0 0;"><b>Customer notes:</b> ${escHtml(ctx.customer_notes)}</p>` : '';
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 12px;">Someone just booked an appointment.</h2>
      <table style="border-collapse:collapse;">${tbl}</table>
      ${items ? `<h3 style="margin:16px 0 6px;font-size:14px;">Job</h3><table style="border-collapse:collapse;font-size:14px;">${items}</table>` : ''}
      ${notes}
      ${booking_id ? `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Booking #${escHtml(booking_id)}</p>` : ''}
    </div>`;
    await sendEmail({ slug: ctx.businessSlug, to, subject: 'Someone just booked an appointment', html, replyTo: cfg.from });
  } catch (e) {
    console.warn('[mirror] owner notify non-fatal:', e.message);
  }
}

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
      address_line1: a.line1 || null, city: a.city || null, state: a.state || null, postal_code: a.postal_code || null,
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
      address_line1: a.line1 || null, city: a.city || null, state: a.state || null, postal_code: a.postal_code || null,
      notes: first(ctx.notes, providerName && `Zenbooker tech: ${providerName}`),
      customer_notes: ctx.customer_notes || null,
      zenbooker_job_id: ctx.zenbooker_job_id ? String(ctx.zenbooker_job_id) : null,
      zenbooker_job_number: job.job_number ? String(job.job_number) : null,
      metadata: { mirrored_at: new Date().toISOString(), source: ctx.source || 'widget' },
    };
    let booking_id = null;
    if (bookingRow.zenbooker_job_id) {
      const { data } = await db.from('bookings')
        .upsert(bookingRow, { onConflict: 'business_id,zenbooker_job_id' }).select('id').single();
      booking_id = data?.id || null;
    } else if (ctx.idempotency_key) {
      // Native bookings: a retried submit (same key) must not duplicate. The
      // idempotency index is PARTIAL (…WHERE idempotency_key IS NOT NULL), which
      // can't be an upsert arbiter — so insert and, on the unique violation,
      // return the existing booking instead (and skip re-writing line items).
      bookingRow.idempotency_key = String(ctx.idempotency_key);
      const ins = await db.from('bookings').insert(bookingRow).select('id').single();
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
      booking_id = (await db.from('bookings').insert(bookingRow).select('id').single()).data?.id || null;
    }
    if (!booking_id) return;

    // Generate review token with the now-known booking_id (30-day TTL: 2592000 seconds)
    const reviewToken = signToken({ booking_id }, 2592000);
    await db.from('bookings').update({ review_token: reviewToken }).eq('id', booking_id);

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

    // Owner heads-up email on customer self-bookings (widget only — not office
    // 'manual', imports, or warranty dispatches). Reaches here only on a NEW
    // booking; the idempotency duplicate path returns earlier, so no double email.
    if ((ctx.source || 'widget') === 'widget') {
      await notifyOwnerNewBooking({ biz, ctx, booking_id, scheduled_at, price, providerName });
    }

    // Native callers (e.g. the Doms widget) need the new row's id to confirm /
    // email the booking. Zenbooker callers ignore the return value.
    return { booking_id, customer_id, business_id: biz.id, technician_id };
  } catch (e) {
    console.warn('[mirror] non-fatal:', e.message);
  }
}
