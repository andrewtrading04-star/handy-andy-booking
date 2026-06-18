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

export async function mirrorBooking(ctx = {}) {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    const db = serviceClient();
    const job = ctx.zbkJob || {};

    const { data: biz } = await db.from('businesses').select('id').eq('slug', ctx.businessSlug).single();
    if (!biz) return;

    // Service area from the Zenbooker territory.
    let service_area_id = null;
    if (ctx.territory_id) {
      const { data: area } = await db.from('service_areas')
        .select('id').eq('business_id', biz.id)
        .eq('zenbooker_territory_id', String(ctx.territory_id)).maybeSingle();
      service_area_id = area?.id || null;
    }

    // Technician: by provider id, then by assigned-provider name, then ctx name.
    const assigned = (job.assigned_providers || job.providers || [])[0] || {};
    const providerName = first(ctx.technician_name, assigned.name, assigned.display_name);
    let technician_id = null;
    const providerId = first(ctx.technician_provider_id, assigned.id, assigned.provider_id);
    if (providerId) {
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
      business_id: biz.id, customer_id, technician_id, service_id, service_area_id,
      status: technician_id ? 'assigned' : 'confirmed',
      source: ctx.source || 'widget',
      scheduled_at: scheduled_at || null,
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
  } catch (e) {
    console.warn('[mirror] non-fatal:', e.message);
  }
}
