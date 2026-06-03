// /api/book.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const { territory_id, service_id, selectedSlot, customer, sections } = req.body || {};

  if (!territory_id)    return res.status(400).json({ error: 'territory_id is required' });
  if (!service_id)      return res.status(400).json({ error: 'service_id is required' });
  if (!selectedSlot)    return res.status(400).json({ error: 'selectedSlot is required' });
  if (!customer?.email) return res.status(400).json({ error: 'customer.email is required' });
  if (!customer?.phone) return res.status(400).json({ error: 'customer.phone is required' });
  if (!Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'sections array is required' });
  }

  const payload = {
    service_id,
    timeslot_id:  selectedSlot,
    territory_id,
    address:      customer.address || '',
    customer: {
      first_name: customer.first_name || '',
      last_name:  customer.last_name  || '',
      email:      customer.email,
      phone:      customer.phone,
    },
    sections,
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
      return res.status(r.status).json({ error: data?.message || 'Booking failed', details: data });
    }
    return res.status(200).json({ success: true, job: data });
  } catch (err) {
    console.error('[book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
