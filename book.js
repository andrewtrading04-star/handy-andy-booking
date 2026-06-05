// /api/book.js
// Confirmed working payload format via live API testing:
//   - services[].selections[] with selected_options[] for multi-select sections
//   - services[].selections[] with option_id (flat) for single-select sections
//   - customer.name (full name string, not first/last separately)
//   - address requires: line1, city, state, postal_code, country

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const {
    territory_id, service_id, selectedSlot,
    customer, city, state, postal_code,
    zbk_selections, other_note,
  } = req.body || {};

  if (!territory_id)       return res.status(400).json({ error: 'territory_id required' });
  if (!service_id)         return res.status(400).json({ error: 'service_id required' });
  if (!selectedSlot)       return res.status(400).json({ error: 'selectedSlot required' });
  if (!customer?.email)    return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)    return res.status(400).json({ error: 'customer.phone required' });
  if (!customer?.address)  return res.status(400).json({ error: 'customer.address required' });

  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  const payload = {
    territory_id,
    timeslot_id: selectedSlot,
    services: [{
      service_id,
      // zbk_selections already in correct Zenbooker format:
      //   multi: { section_id, selected_options: [{option_id, quantity}] }
      //   single: { section_id, option_id }
      selections: zbk_selections || [],
    }],
    customer: {
      name:  fullName,
      email: customer.email,
      phone: customer.phone,
    },
    address: {
      line1:       customer.address,
      city:        city        || '',
      state:       state       || '',
      postal_code: postal_code || customer.zip || '',
      country:     'US',
    },
    // Auto-enable both notification switches on every booking
    email_notifications: true,
    sms_notifications:   true,
    // Include "Other" free-text note if customer provided one
    ...(other_note && { notes: `Customer request: ${other_note}` }),
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

    return res.status(200).json({ success: true, job_id: data.job_id, status: data.status });

  } catch (err) {
    console.error('[book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
