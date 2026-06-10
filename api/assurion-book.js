// /api/assurion-book.js
// Creates a Zenbooker job for the Assurion widget. Key rules:
//   - Assigned to STEVE ONLY (assigned_providers fixed server-side).
//   - NO credit card / payment method involved.
//   - All line items are $0 custom services (no pricing imported).
// The widget sends: { customer, address fields, selectedSlot, lines:[labels], notes }
const STEVE_PROVIDER_ID = '1688834379840x866068852960133100'; // Steve B.
const ASSURION_TERRITORY_ID = '1685582903241x973573877706522600'; // Denver #1

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const { customer, selectedSlot, lines, notes } = req.body || {};
  if (!selectedSlot)        return res.status(400).json({ error: 'A time slot is required' });
  if (!customer?.email)     return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)     return res.status(400).json({ error: 'customer.phone required' });
  if (!customer?.address)   return res.status(400).json({ error: 'customer.address required' });

  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  // Every selection becomes a $0 custom-service line item (no prices imported).
  const labels = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const services = labels.map((label, i) => ({
    custom_service: { name: String(label).slice(0, 120), price: 0, duration: i === 0 ? 120 : 0, taxable: false },
  }));
  if (!services.length) {
    services.push({ custom_service: { name: 'Assurion TV Mounting', price: 0, duration: 120, taxable: false } });
  }

  const payload = {
    territory_id: ASSURION_TERRITORY_ID,
    timeslot_id: selectedSlot,
    services,
    duration: 120,
    customer: { name: fullName, email: customer.email, phone: customer.phone },
    address: {
      line1:       customer.address,
      city:        customer.city  || '',
      state:       customer.state || '',
      postal_code: customer.zip   || '',
      country:     'US',
    },
    assigned_providers: [STEVE_PROVIDER_ID], // Steve only
    min_providers_needed: '1',
    email_notifications: true,
    sms_notifications:   true,
  };

  try {
    const r = await fetch('https://api.zenbooker.com/v1/jobs', {
      method:  'POST',
      headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[assurion-book] Zenbooker error', r.status, JSON.stringify(data));
      return res.status(r.status).json({ error: data?.error?.message || data?.message || 'Booking failed', details: data });
    }

    const jobId = data.job_id || data.id;

    // Write a note so Steve sees the full request in one place.
    if (jobId && notes) {
      try {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: String(notes).slice(0, 2000) }),
        });
      } catch (noteErr) { console.warn('[assurion-book] note failed:', noteErr.message); }
    }

    return res.status(200).json({ success: true, job_id: jobId, status: data.status });
  } catch (err) {
    console.error('[assurion-book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
