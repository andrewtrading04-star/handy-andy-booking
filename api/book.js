// /api/book.js
// Creates a Zenbooker job from the widget's final submission.
// Docs: https://developers.zenbooker.com/reference/create-a-job

// ---- Config (edit these to match your Zenbooker account) ----

const ZENBOOKER_SERVICE_ID = '1653587266109x109705534410984510'; // TV Mounting service

// Map first 2 digits of zip -> { territory_id, city, state }
const TERRITORY_BY_ZIP_PREFIX = {
  '80': { territory_id: '1685582903241x973573877706522600', city: 'Denver',  state: 'CO' },
  '77': { territory_id: '1707514546803x280800015001583600', city: 'Houston', state: 'TX' },
  '78': { territory_id: '1724797832896x339501352491155460', city: 'Austin',  state: 'TX' },
};

// section_id values for each step of the widget.
// You already had size / bracket / lift. Fill the rest from your Zenbooker service
// definition (GET /v1/services/{service_id} returns the section_ids).
const SECTION_IDS = {
  size:    '1653587266762x644740117412491400',
  bracket: '1653587266762x547068990139036900',
  lift:    '1653706185664x743252558441611300',
  fp:      null,    // TODO: paste fireplace section_id
  wire:    null,    // TODO: paste wire-hiding section_id
  extras:  null,    // TODO: paste add-ons section_id (multi-select)
};

// ---- Handler ----

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.ihandyandy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) {
    return res.status(500).json({ error: 'ZENBOOKER_API_KEY is not set in Vercel env vars' });
  }

  // Body is auto-parsed by Vercel when Content-Type is application/json
  const { customer, address, zip, selections, timeslot_id } = req.body || {};

  // Validate
  if (!customer?.firstName || !customer?.lastName || !customer?.phone || !customer?.email) {
    return res.status(400).json({ error: 'Missing customer fields' });
  }
  if (!address || !zip) {
    return res.status(400).json({ error: 'Missing address or zip' });
  }
  if (!selections?.size?.id || !selections?.bracket?.id || !selections?.lift?.id) {
    return res.status(400).json({ error: 'Missing required selections (size, bracket, lift)' });
  }
  if (!timeslot_id) {
    return res.status(400).json({ error: 'Missing timeslot_id — customer must pick a slot first' });
  }

  // Resolve territory from zip
  const territory = TERRITORY_BY_ZIP_PREFIX[zip.substring(0, 2)];
  if (!territory) {
    return res.status(400).json({ error: `Service not available in zip ${zip}` });
  }

  // Build the selections array, skipping any that don't have a section_id configured
  const selectionEntries = [];
  const pushSel = (key, optionId) => {
    if (!optionId || !SECTION_IDS[key]) return;
    selectionEntries.push({
      section_id: SECTION_IDS[key],
      selected_options: [{ option_id: optionId, quantity: 1 }],
    });
  };
  pushSel('size',    selections.size?.id);
  pushSel('bracket', selections.bracket?.id);
  pushSel('lift',    selections.lift?.id);
  pushSel('fp',      selections.fp?.id);
  pushSel('wire',    selections.wire?.id);

  // Multi-select extras (if you wire them up)
  if (Array.isArray(selections.extras) && selections.extras.length && SECTION_IDS.extras) {
    selectionEntries.push({
      section_id: SECTION_IDS.extras,
      selected_options: selections.extras
        .filter(e => e?.id)
        .map(e => ({ option_id: e.id, quantity: 1 })),
    });
  }

  const jobPayload = {
    territory_id: territory.territory_id,
    timeslot_id,
    customer: {
      name:  `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email,
      phone: customer.phone,
    },
    address: {
      line1:       address,
      city:        territory.city,
      state:       territory.state,
      postal_code: zip,
    },
    services: [
      {
        service_id: ZENBOOKER_SERVICE_ID,
        selections: selectionEntries,
      },
    ],
    sms_notifications:   true,
    email_notifications: true,
  };

  // Call Zenbooker
  try {
    const zbkRes = await fetch('https://api.zenbooker.com/v1/jobs', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${ZBK_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(jobPayload),
    });

    const data = await zbkRes.json().catch(() => ({}));

    if (!zbkRes.ok) {
      console.error('Zenbooker create job failed', zbkRes.status, data);
      return res.status(zbkRes.status).json({
        error: data?.message || data?.error || 'Zenbooker rejected the booking',
        details: data,
      });
    }

    return res.status(200).json({
      ok: true,
      job_id:   data.job_id,
      status:   data.status,
      timeslot: data.timeslot,
      pricing:  data.pricing,
    });
  } catch (err) {
    console.error('book.js fetch threw', err);
    return res.status(500).json({ error: 'Failed to reach Zenbooker', message: err.message });
  }
}
