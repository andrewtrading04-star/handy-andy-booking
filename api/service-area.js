// /api/service-area.js
// Looks up which service area covers a zip code. Every real business is
// native — answers come from the CRM's own service_area_zips table (per-zip
// travel surcharge included). Zenbooker was canceled 2026-07-31; nothing
// here calls out to it.
import { serviceClient } from './_lib/supabase.js';
import { NATIVE_SLUGS } from './_lib/native-businesses.js';

// The table stores bare 5-digit zips; callers sometimes send a ZIP+4
// ("80220-1032", office form, Jul 2026), which the exact-match lookup missed,
// reading a real Denver address as "not covered". Keep the leading 5 digits.
// STRICT shape: only a bare zip or a real ZIP+4 tail normalizes; a 6-digit
// typo ("800122") must NOT silently become the different-but-real zip 80012,
// it stays as typed and fails closed.
function zip5(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{5})(?:[-\s]\d{1,4})?$/);
  return m ? m[1] : s;
}

// Native CRM zip check for Doms — no Zenbooker. Returns whether the zip is
// covered, the per-zip surcharge, and a metro default city/state.
async function domsServiceArea(req, res) {
  const zip = zip5((req.body && (req.body.zip || req.body.postal_code)) || '');
  if (!zip) return res.status(400).json({ error: 'zip is required' });
  try {
    const db = serviceClient();
    const { data: biz } = await db.from('businesses').select('id').eq('slug', 'doms').single();
    if (!biz) return res.status(500).json({ error: 'Doms business not configured' });
    // select('*') is resilient if the surcharge column (migration 0031) isn't applied yet.
    const { data: z } = await db.from('service_area_zips')
      .select('*').eq('business_id', biz.id).eq('postal_code', zip).maybeSingle();
    if (!z) return res.status(200).json({ in_service_area: false, territory_id: null });
    return res.status(200).json({
      in_service_area: true,
      territory_id:    'doms-denver',   // sentinel: Doms has no Zenbooker territory
      territory_name:  'Denver',
      surcharge:       Number(z.surcharge) || 0,
      timezone:        'America/Denver',
      city:            'Denver',
      state:           'CO',
      lat:             null,
      lng:             null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Service area check failed', message: err.message });
  }
}

// Generic native CRM zip check (no Zenbooker) for a multi-metro business. Looks
// the zip up in service_area_zips, then returns its service_area_id + that
// metro's timezone + the per-zip surcharge. The widget passes service_area_id
// back to /api/slots so availability is scoped to the right metro's techs/tz.
async function nativeServiceArea(req, res, slug) {
  const zip = zip5((req.body && (req.body.zip || req.body.postal_code)) || '');
  if (!zip) return res.status(400).json({ error: 'zip is required' });
  try {
    const db = serviceClient();
    const { data: biz } = await db.from('businesses').select('id').eq('slug', slug).single();
    if (!biz) return res.status(500).json({ error: `${slug} business not configured` });
    // select('surcharge, price_adjustment_amount, ...'), but fall back to a
    // select without price_adjustment_amount if migration 0083 hasn't landed
    // on this deploy yet -- same resilience pattern domsServiceArea uses for
    // surcharge. A flat DOLLAR amount, not a percentage (owner-set, per zip,
    // 0 for every zip until explicitly configured) -- see widget.js
    // zipFlatAdjustment() for how it's folded silently into the total.
    let z, zErr;
    ({ data: z, error: zErr } = await db.from('service_area_zips')
      .select('surcharge, price_adjustment_amount, service_area:service_areas ( id, name, state, timezone, unstaffed )')
      .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle());
    if (zErr && /(price_adjustment_amount|unstaffed)/.test(zErr.message || '')) {
      ({ data: z } = await db.from('service_area_zips')
        .select('surcharge, service_area:service_areas ( id, name, state, timezone )')
        .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle());
    }
    if (!z || !z.service_area) {
      // ANY California zip (90000-96199, the full CA range) routes to the
      // unstaffed Los Angeles REQUEST flow -- the LA pages are live but there
      // are no techs there, so this only gauges demand through the booking
      // funnel, exactly like DFW: no travel fee, no tech assignment, never the
      // real booking flow. Deliberately a range fallback instead of seeding
      // thousands of service_area_zips rows; a real LA launch later just seeds
      // real zips + techs and flips unstaffed off, and per-zip rows would then
      // take precedence over this fallback anyway.
      if (slug === 'handy-andy' && /^9(?:[0-5]\d{3}|6[01]\d{2})$/.test(zip)) {
        const { data: la } = await db.from('service_areas')
          .select('id, name, state, timezone, unstaffed')
          .eq('business_id', biz.id).eq('state', 'CA').eq('active', true).maybeSingle();
        if (la && la.unstaffed) {
          return res.status(200).json({
            in_service_area: true,
            territory_id:    la.id,
            service_area_id: la.id,
            territory_name:  la.name,
            unstaffed:       true,
            surcharge:       0,
            price_adjustment_amount: 0,
            timezone:        la.timezone || 'America/Los_Angeles',
            city:            la.name,
            state:           'CA',
            lat:             null,
            lng:             null,
          });
        }
      }
      return res.status(200).json({ in_service_area: false, territory_id: null });
    }
    const area = z.service_area;
    return res.status(200).json({
      in_service_area: true,
      // The service_area_id doubles as the "territory" id the widget echoes back.
      territory_id:    area.id,
      service_area_id: area.id,
      territory_name:  area.name,
      // No tech roster in this area yet (owner-set on the service area, e.g.
      // DFW). The widget NEVER surfaces this fact to the customer -- it only
      // switches which flow renders (request vs. a confirmed slot + card).
      // See public/widget.js's `unstaffed`-gated branch below.
      unstaffed:       !!area.unstaffed,
      surcharge:       Number(z.surcharge) || 0,
      price_adjustment_amount: Number(z.price_adjustment_amount) || 0,
      timezone:        area.timezone || 'America/Denver',
      city:            area.name || null,
      state:           area.state || null,
      lat:             null,
      lng:             null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Service area check failed', message: err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Native CRM businesses — branch before any Zenbooker work.
  if (req.body && req.body.business === 'doms') return domsServiceArea(req, res);
  if (req.body && NATIVE_SLUGS.includes(req.body.business)) return nativeServiceArea(req, res, req.body.business);

  // Zenbooker was canceled 2026-07-31 and must never be called, live or
  // otherwise. Every real business (Handy Andy, Mile High, Doms) is already
  // handled by the native branches above; a request that falls through to
  // here means req.body.business was missing or unrecognized, not a genuine
  // Zenbooker-era caller (there are none left). Fail loud instead of ever
  // reaching for the old API.
  return res.status(410).json({ error: 'Unknown or missing business. Zenbooker is no longer used — pass business=handy-andy, mile-high, or doms.' });
}
