// /api/places — address autocomplete for the office screens, as an EDGE function
// (owner 2026-09-28: "as fast as freaking possible").
//
// Why a separate file: api/admin.js runs in one US region, so every keystroke
// from Bangkok made a ~500 ms round trip before Google was even asked. An edge
// function runs in the Vercel region nearest whoever is typing and calls Google
// from there, so a suggestion comes back in roughly a fifth of the time.
// admin.js keeps its places_autocomplete / place_details actions as the
// fallback the page uses if this endpoint ever fails.
//
// GET ?q=<typed>&zip=<quoted zip>&session=<token>   -> { predictions: [...] }
// GET ?zip=<5 digits> (no q)                        -> { city, state, zip }
// GET ?place_id=<id>&session=<token>                -> { address: {...} }
// Auth: the same signed session token as api/admin.js (owner or secretary).
export const config = { runtime: 'edge' };

const enc = new TextEncoder();
let _key = null;
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Same HMAC-SHA256 check as verifyToken() in api/_lib/auth.js, on Web Crypto
// (the edge runtime has no node:crypto). subtle.verify is constant-time.
async function verify(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  try {
    _key ||= await crypto.subtle.importKey('raw', enc.encode(process.env.SESSION_SECRET || 'dev-insecure-secret-change-me'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('HMAC', _key, b64urlBytes(sig), enc.encode(data)))) return null;
    const body = JSON.parse(new TextDecoder().decode(b64urlBytes(data)));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// "Houston, TX 77063, USA" -> { city, state, zip }
function splitSecondary(text) {
  const parts = String(text || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts[parts.length - 1] === 'USA') parts.pop();
  const m = (parts[parts.length - 1] || '').match(/^([A-Z]{2})(?:\s+(\d{5}))?$/);
  return m ? { city: parts.length > 1 ? parts[parts.length - 2] : '', state: m[1], zip: m[2] || '' } : { city: '', state: '', zip: '' };
}

async function autocomplete(key, input, session, types) {
  const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  u.searchParams.set('input', input);
  u.searchParams.set('key', key);
  u.searchParams.set('types', types);
  u.searchParams.set('components', 'country:us');
  if (session) u.searchParams.set('sessiontoken', session);
  const j = await (await fetch(u)).json();
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') console.warn('[places-edge]', j.status, j.error_message || '');
  return (j.predictions || []).slice(0, 5).map(p => {
    const sf = p.structured_formatting || {};
    return { description: p.description, place_id: p.place_id, street: sf.main_text || '', ...splitSecondary(sf.secondary_text) };
  });
}

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const auth = await verify((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!auth || (auth.role !== 'owner' && auth.role !== 'secretary')) return json({ error: 'Unauthorized' }, 401);
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return json({ predictions: [] });
  const p = new URL(request.url).searchParams;
  const q = (p.get('q') || '').trim().slice(0, 200);
  const zip = /^\d{5}$/.test(p.get('zip') || '') ? p.get('zip') : '';
  const session = (p.get('session') || '').slice(0, 64);
  const placeId = (p.get('place_id') || '').slice(0, 300);
  try {
    if (placeId) {
      const u = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      u.searchParams.set('place_id', placeId);
      u.searchParams.set('key', key);
      u.searchParams.set('fields', 'address_component');
      if (session) u.searchParams.set('sessiontoken', session);
      const j = await (await fetch(u)).json();
      if (j.status !== 'OK') return json({ address: null, status: j.status });
      const comps = j.result?.address_components || [];
      const get = (type, short) => { const c = comps.find(x => (x.types || []).includes(type)); return c ? (short ? c.short_name : c.long_name) : ''; };
      return json({ address: {
        street: [get('street_number'), get('route')].filter(Boolean).join(' '),
        city: get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_2'),
        state: get('administrative_area_level_1', true),
        zip: get('postal_code'),
      } });
    }
    if (!q && zip) {
      // City + state for a ZIP, so the form can fill them before anyone types.
      const r = (await autocomplete(key, zip, '', '(regions)'))[0];
      return json(r ? { city: r.street === zip ? r.city : r.street, state: r.state, zip } : {});
    }
    if (q.length < 3) return json({ predictions: [] });
    // With the ZIP from the call, the right house is usually the only answer.
    // Both lookups run at once; the plain one covers a ZIP that was wrong.
    const hasZip = /\b\d{5}\b/.test(q);
    const [withZip, plain] = await Promise.all([
      zip && !hasZip ? autocomplete(key, `${q} ${zip}`, session, 'address') : Promise.resolve([]),
      autocomplete(key, q, session, 'address'),
    ]);
    const seen = new Set();
    const predictions = [...withZip, ...plain].filter(x => !seen.has(x.place_id) && seen.add(x.place_id)).slice(0, 5);
    return json({ predictions });
  } catch (e) {
    console.error('[places-edge] failed:', e.message);
    return json({ predictions: [], error: 'lookup failed' }, 502);
  }
}
