// /api/book.js
// Creates a Zenbooker job from the widget's final submission.

const ZENBOOKER_SERVICE_ID = '1653587266109x109705534410984510';

const TERRITORY_BY_ZIP_PREFIX = {
  '80': { territory_id: '1685582903241x973573877706522600', city: 'Denver',  state: 'CO' },
  '77': { territory_id: '1707514546803x280800015001583600', city: 'Houston', state: 'TX' },
  '78': { territory_id: '1724797832896x339501352491155460', city: 'Austin',  state: 'TX' },
};

const SECTION_IDS = {
  size:    '1653587266762x644740117412491400',
  bracket: '1653587266762x547068990139036900',
  lift:    '1653706185664x743252558441611300',
  fp:      null,
  wire:    null,
  extras:  null,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.ihandyandy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) {
    return res.status(500).json({ error: 'ZENBOOKER_API_KEY is not set in Vercel env vars' });
  }

  const body = req.body || {};

  const customer = body.customer || {
    firstName: body.firstName || body.first_name || body.fname,
    lastName:  body.lastName  || body.last_name  || body.lname,
    phone:     body.phone     || body.phoneNumber || body.phone_number,
    email:     body.email,
  };
  const address     = body.address || body.streetAddress || body.street_address;
  const zip         = body.zip     || body.zipCode       || body.zip_code || body.postal_code;
  const selections  = body.selections;
  const timeslot_id = body.timeslot_id || body.timeslotId;

  const missing = [];
  if (!customer?.firstName) missing.push('firstName');
  if (!customer?.lastName)  missing.push('lastName');
  if (!customer?.phone)     missing.push('phone');
  if (!customer?.email)     missing.push('email');
  if (!address)             missing.push('address');
  if (!zip)                 missing.push('zip');
  if (missing.length) {
    return res.status(400).json({
      error: `Missing fields: ${missing.join(', ')}`,
      received_keys: Object.keys(body),
    });
  }

  if (!selections?.size?.id || !selections?.bracket?.id || !selections?.lift?.id) {
    return res.status(400).json({
      error: 'Missing required selections (size, bracket, lift)',
      received_selections: selections,
    });
  }

  if (!timeslot_id) {
    return res.status(400).json({
      error: 'Missing timeslot_id — customer must pick a slot first',
    });
  }

  const territory = TERRITORY_BY_ZIP_PREFIX[String(zip).substring(0, 2)];
  if (!territory) {
    return res.status(400).json({ error: `Service not available in zip ${zip}` });
  }

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

  if (Array.isArray(selections.extras) && selections.extras
