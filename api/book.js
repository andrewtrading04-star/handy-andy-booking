// /api/book.js
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
    zbk_selections
  } = req.body || {};

  if (!territory_id)      return res.status(400).json({ error: 'territory_id required' });
  if (!service_id)        return res.status(400).json({ error: 'service_id required' });
  if (!selectedSlot)      return res.status(400).json({ error: 'selectedSlot required' });
  if (!customer?.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!customer?.address) return res.status(400).json({ error: 'customer.address required' });

  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  const payload = {
    territory_id,
    timeslot_id: selectedSlot,
    services: [{
      service_id,
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
      return res.status(r.status).json({ error: data?.error?.message || 'Booking failed', details: data });
    }
    return res.status(200).json({ success: true, job_id: data.job_id, status: data.status });
  } catch (err) {
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
