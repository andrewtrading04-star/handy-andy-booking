// /api/assurion-book.js
// Creates a Zenbooker job for the Asurion/Techs To You widget.
// - Assigned to STEVE ONLY (server-side enforced).
// - All line items are $0 custom services.
// - No credit card / payment method.
const STEVE_PROVIDER_ID  = '1688834379840x866068852960133100'; // Steve B.
const DEFAULT_TERRITORY  = '1685582903241x973573877706522600'; // Denver #1 fallback

// Payout rates: hardcoded values + 60% of flat rate
const PAYOUTS = {
  'Television':                          60,    // hardcoded
  'Frame TV (Art Style)':                15,    // hardcoded
  'Extra Man (TV over 50")':             50,    // hardcoded
  'Sound Bar':                           51,    // 85 × 0.60
  'Alarm Keypad':                        75,    // 125 × 0.60
  'Alarm Range Extender':                75,    // 125 × 0.60
  'Alarm Panic Button':                  75,    // 125 × 0.60
  'Flood Sensor':                        60,    // 100 × 0.60
  'Glass Break Sensor':                  60,    // 100 × 0.60
  'Contact Sensor':                      60,    // 100 × 0.60
  'Security Camera':                     75,    // 125 × 0.60
  'Door Locks':                          75,    // 125 × 0.60
  'Door Bell':                           75,    // 125 × 0.60
  'Smart Hub':                           90,    // 150 × 0.60
  'Thermostat':                          75,    // 125 × 0.60
  'Light Dimmer':                        60,    // 100 × 0.60
  'Truck Roll Fee (if job can\'t be completed)': 60, // hardcoded
  // Special Mount (Articulating or Motion) — NO PAYOUT
};

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

  // ── Resolve city/state server-side if they arrive empty (mirrors api/book.js).
  // Zenbooker rejects job creation when the address lacks city or state.
  let resolvedCity  = (customer.city  || '').trim();
  let resolvedState = (customer.state || '').trim();
  const zipForLookup = String(customer.zip || '').trim();
  if ((!resolvedCity || !resolvedState) && zipForLookup) {
    try {
      const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
      url.searchParams.set('postal_code', zipForLookup);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
      const d = await r.json().catch(() => ({}));
      resolvedCity  = resolvedCity  || d.customer_location?.components?.city  || '';
      resolvedState = resolvedState || d.customer_location?.components?.state || '';
    } catch (e) { console.warn('[assurion-book] city/state lookup failed:', e.message); }
  }
  // Last resort: all Assurion territories are Denver-metro, so never send empty city/state.
  resolvedCity  = resolvedCity  || 'Denver';
  resolvedState = resolvedState || 'CO';

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
      city:        resolvedCity,
      state:       resolvedState,
      postal_code: zipForLookup,
      country:     'US',
    },
    assigned_providers:  [STEVE_PROVIDER_ID],
    min_providers_needed:'1',
    email_notifications: false,
    sms_notifications:   false,
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

    // Build payout note from selected line items
    const payoutLines = labels.map(label => {
      const rate = PAYOUTS[label];
      return rate !== undefined ? `${label} — $${rate}` : `${label} — rate TBD`;
    });
    const totalPayout = labels.reduce((sum, label) => sum + (PAYOUTS[label] || 0), 0);
    const jobNote = [
      'Assurion job',
      '',
      ...payoutLines,
      '',
      `Tech pay: $${totalPayout}`,
    ].join('\n');

    // Write job note so Steve sees full request detail
    if (jobId) {
      try {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: jobNote.slice(0, 2000) }),
        });
      } catch (e) { console.warn('[assurion-book] note failed:', e.message); }
    }

    return res.status(200).json({ success: true, job_id: jobId, status: data.status });
  } catch (err) {
    console.error('[assurion-book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
