export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const {
    territory_id, service_id, selectedSlot,
    customer, city, state, postal_code, zbk_selections, tip, payment_method_id,
    min_providers_needed, assignment_method,
  } = req.body || {};

  if (!territory_id)      return res.status(400).json({ error: 'territory_id required' });
  if (!service_id)        return res.status(400).json({ error: 'service_id required' });
  if (!customer?.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!customer?.address) return res.status(400).json({ error: 'customer.address required' });
  if (!selectedSlot) {
    return res.status(400).json({ error: 'selectedSlot required for a booking' });
  }

  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  // ── Resolve city/state server-side if the widget didn't send them.
  // Zenbooker rejects bookings whose address lacks city or state, and older
  // cached copies of widget.js only knew city/state for 4 territories.
  let resolvedCity  = (city  || '').trim();
  let resolvedState = (state || '').trim();
  const zipForLookup = String(postal_code || customer.zip || '').trim();
  if ((!resolvedCity || !resolvedState) && zipForLookup) {
    try {
      const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
      url.searchParams.set('postal_code', zipForLookup);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
      const d = await r.json().catch(() => ({}));
      resolvedCity  = resolvedCity  || d.customer_location?.components?.city  || '';
      resolvedState = resolvedState || d.customer_location?.components?.state || '';
    } catch (e) { console.warn('[book] city/state lookup failed:', e.message); }
  }
  // Last resort: metro-level fallback by territory so the booking never fails on empty city/state.
  const TERRITORY_FALLBACK = {
    '1707514546803x280800015001583600': { city: 'Houston',     state: 'TX' }, // Houston #1
    '1685582903241x973573877706522600': { city: 'Denver',      state: 'CO' }, // Denver #1
    '1707513178246x806633139915194400': { city: 'Denver',      state: 'CO' }, // Denver #2
    '1687393551618x123774611115737090': { city: 'Denver',      state: 'CO' }, // Denver #3
    '1723559782141x609094402068185100': { city: 'Denver',      state: 'CO' }, // Denver #4 Boulder/CS
    '1724797832896x339501352491155460': { city: 'Austin',      state: 'TX' },
    '1760944311332x492178768310304800': { city: 'Los Angeles', state: 'CA' },
  };
  const fb = TERRITORY_FALLBACK[territory_id] || {};
  resolvedCity  = resolvedCity  || fb.city  || '';
  resolvedState = resolvedState || fb.state || '';

  const services = [{ service_id, selections: zbk_selections || [] }];
  if (tip && Number(tip) > 0) {
    services.push({ custom_service: { name: 'Tip for technician', price: Number(tip), duration: 0, taxable: false } });
  }

  const payload = {
    territory_id,
    services,
    customer: { name: fullName, email: customer.email, phone: customer.phone },
    address: {
      line1:       customer.address,
      city:        resolvedCity,
      state:       resolvedState,
      postal_code: zipForLookup,
      country:     'US',
    },
    email_notifications: true,
    sms_notifications:   true,
    // Denver 98"+ → require & auto-assign 2 technicians
    ...(min_providers_needed && { min_providers_needed: String(min_providers_needed) }),
    ...(assignment_method   && { assignment_method }),
    ...(selectedSlot && { timeslot_id: selectedSlot }),
  };

  try {
    const r = await fetch('https://api.zenbooker.com/v1/jobs', {
      method:  'POST',
      headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[book] Zenbooker error', r.status, JSON.stringify(data));
      return res.status(r.status).json({ error: data?.error?.message || data?.message || 'Booking failed', details: data });
    }

    const jobId = data.job_id || data.id;
    const zbkCustomerId = data.customer_id || data.customer?.id || null;

    // ---- Save the card on file in Stripe so it appears as a payment method and can be charged later ----
    let cardNote = '';
    if (payment_method_id) {
      const SK = process.env.STRIPE_SECRET_KEY;
      if (!SK) {
        cardNote = `Payment method captured (${payment_method_id}) but STRIPE_SECRET_KEY is not set on the server, so the card was NOT saved on file.`;
      } else {
        const sAuth = { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' };
        try {
          // 1) Prefer the Zenbooker customer's existing Stripe customer (returning customer) so the card shows in Zenbooker.
          let stripeCustomerId = null;
          try {
            const cr = await fetch(`https://api.zenbooker.com/v1/customers?email=${encodeURIComponent(customer.email)}&limit=10`, { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
            const cj = await cr.json().catch(() => ({}));
            const results = cj.results || cj.data || [];
            const match = results.find(c => c.id === zbkCustomerId && c.stripe_customer_id)
                       || results.find(c => (c.email || '').toLowerCase() === (customer.email || '').toLowerCase() && c.stripe_customer_id);
            if (match) stripeCustomerId = match.stripe_customer_id;
          } catch (e) { /* lookup is best-effort */ }

          // 2) Otherwise create a Stripe customer on this account.
          if (!stripeCustomerId) {
            const cb = new URLSearchParams();
            cb.set('email', customer.email || '');
            if (fullName) cb.set('name', fullName);
            if (customer.phone) cb.set('phone', customer.phone);
            cb.set('description', 'Booking widget customer');
            const ccr = await fetch('https://api.stripe.com/v1/customers', { method: 'POST', headers: sAuth, body: cb });
            const cc = await ccr.json();
            if (!ccr.ok) throw new Error(cc?.error?.message || 'Stripe customer create failed');
            stripeCustomerId = cc.id;
          }

          // 3) Attach the payment method to that Stripe customer and make it the default.
          const ab = new URLSearchParams(); ab.set('customer', stripeCustomerId);
          const ar = await fetch(`https://api.stripe.com/v1/payment_methods/${payment_method_id}/attach`, { method: 'POST', headers: sAuth, body: ab });
          const pm = await ar.json();
          if (!ar.ok) throw new Error(pm?.error?.message || 'Attach failed');

          const db = new URLSearchParams(); db.set('invoice_settings[default_payment_method]', payment_method_id);

          // 4) Link the Zenbooker customer to this Stripe customer so Zenbooker displays the card in the Payment Methods section.
          if (zbkCustomerId) {
            try {
              await fetch(`https://api.zenbooker.com/v1/customers/${zbkCustomerId}`, {
                method: "PATCH",
                headers: { Authorization: `Bearer ${ZBK_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
              });
            } catch (updateErr) {
              console.warn("[book] Failed to link Zenbooker customer to Stripe:", updateErr.message);
            }
          }
          await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, { method: 'POST', headers: sAuth, body: db });

          const brand = pm?.card?.brand || 'card';
          const last4 = pm?.card?.last4 || '????';
          // Customer-friendly card-on-file note shown on the job.
          cardNote = `Card is on file. To access card click "Payment method > Edit > Click card on file."`;
        } catch (e) {
          console.error('[book] stripe save error:', e.message);
          cardNote = `Payment method captured (${payment_method_id}) but saving on file failed: ${e.message}`;
        }
      }
    }

    // Write a note on the job describing the card-on-file status.
    if (jobId && cardNote) {
      try {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: cardNote }),
        });
      } catch (noteErr) {
        console.warn('[book] Failed to add note:', noteErr.message);
      }
    }

    return res.status(200).json({ success: true, job_id: jobId, status: data.status, card_saved: /Card is on file/.test(cardNote) });
  } catch (err) {
    console.error('[book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
