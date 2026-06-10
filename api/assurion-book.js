// /api/assurion-book.js
// Creates a Zenbooker job for the Asurion/Techs To You widget.
// - Assigned to STEVE ONLY (server-side enforced).
// - All line items are $0 custom services.
// - No credit card / payment method.
const STEVE_PROVIDER_ID  = '1688834379840x866068852960133100'; // Steve B.
const DEFAULT_TERRITORY  = '1685582903241x973573877706522600'; // Denver #1 fallback

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const { customer, selectedSlot, lines, notes, territory_id } = req.body || {};
  if (!selectedSlot)      return res.status(400).json({ error: 'A time slot is required' });
  if (!customer?.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!customer?.address) return res.status(400).json({ error: 'customer.address required' });

  const territory = String(territory_id || DEFAULT_TERRITORY);
  const fullName  = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  // Every selection → $0 custom service line item
  const labels   = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const services = labels.map((label, i) => ({
    custom_service: { name: String(label).slice(0, 120), price: 0, duration: i === 0 ? 120 : 0, taxable: false },
  }));
  if (!services.length) {
    services.push({ custom_service: { name: 'Asurion TV Service', price: 0, duration: 120, taxable: false } });
  }

  const payload = {
    territory_id:       territory,
    timeslot_id:        selectedSlot,
    services,
    duration:           120,
    customer:           { name: fullName, email: customer.email, phone: customer.phone },
    address: {
      line1:       customer.address,
      city:        customer.city  || '',
      state:       customer.state || '',
      postal_code: customer.zip   || '',
      country:     'US',
    },
    assigned_providers:  [STEVE_PROVIDER_ID],
    min_providers_needed:'1',
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

    // Write job note so Steve sees full request detail
    if (jobId && notes) {
      try {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: String(notes).slice(0, 2000) }),
        });
      } catch (e) { console.warn('[assurion-book] note failed:', e.message); }
    }

    return res.status(200).json({ success: true, job_id: jobId, status: data.status });
  } catch (err) {
    console.error('[assurion-book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
