export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST' && req.method !== 'OPTIONS') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { customer, address, zip, city, selections } = req.body;
  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  
  if (!ZBK_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Map zip to territory based on first 2 digits
  const zipPrefix = zip.substring(0, 2);
  const zipTerritoryMap = {
    '80': '1685582903241x973573877706522600', // Denver
    '77': '1707514546803x280800015001583600', // Houston
    '78': '1724797832896x339501352491155460'  // Austin
  };

  const territoryId = zipTerritoryMap[zipPrefix];
  if (!territoryId) {
    return res.status(400).json({ error: `Service not available for zip ${zip}` });
  }

  const size = selections.size;
  const bracket = selections.bracket;
  const lift = selections.lift;
  const fp = selections.fp;
  const wire = selections.wire;
  const extras = selections.extras || [];
  const isTvLarge = size?.large === true;
  const minProviders = isTvLarge ? '2' : '1';

  const services = [
    {
      service_id: '1653587266109x109705534410984510',
      selections: [
        {
          section_id: '1653587266762x644740117412491400',
          selected_options: [{ option_id: size.id, quantity: 1 }]
        },
        {
          section_id: '1653587266762x547068990139036900',
          selected_options: [{ option_id: bracket.id, quantity: 1 }]
        },
        {
          section_id: '1653706185664x743252558441611300',
          selected_options: [{ option_id: lift.id, quantity: 1 }]
        },
        {
          section_id: '1693450777428x891835261005594600',
          selected_options: [{ option_id: fp.id, quantity: 1 }]
        },
        {
          section_id: '1653609304556x656354672724410400',
          selected_options: [{ option_id: wire.id, quantity: 1 }]
        },
        ...(extras.length > 0 ? [{
          section_id: '1653592844995x671476707651485700',
          selected_options: extras.map(e => ({ option_id: e.id, quantity: 1 }))
        }] : [])
      ]
    }
  ];

  const payload = {
    territory_id: territoryId,
    customer: {
      name: `${customer.first_name} ${customer.last_name}`,
      phone: customer.phone,
      email: customer.email
    },
    address: {
      line1: address.line1,
      postal_code: zip
    },
    services,
    min_providers_needed: minProviders,
    timeslot: {
      type: 'arrival_window',
      start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    },
    sms_notifications: true,
    email_notifications: true
  };

  try {
    const response = await fetch('https://api.zenbooker.com/v1/jobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZBK_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Booking failed' });
    }

    return res.status(201).json({ job_id: data.job_id, status: data.status });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
