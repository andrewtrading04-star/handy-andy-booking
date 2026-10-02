// /api/slots.js
// Returns bookable appointment times. Every real business (Handy Andy, Mile
// High, Doms) is native — open slots come from the CRM's own technician
// availability minus existing bookings. Zenbooker was canceled 2026-07-31;
// the branch below this point is a dead-end, not a live fallback.
import { serviceClient } from './_lib/supabase.js';
import { publicOpenSlots } from './_lib/availability.js';
import { NATIVE_SLUGS } from './_lib/native-businesses.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const src = req.method === 'GET' ? req.query : (req.body || {});

  // Doms is CRM-native — branch before any Zenbooker work. Same response shape
  // as the Zenbooker proxy: { days: [{ date, timeslots: [{ id, formatted }] }] }.
  if (src.business === 'doms') {
    try {
      const db = serviceClient();
      // Multi-metro since OKC (2026-10): the widget echoes the zip check's
      // service_area_id/territory_id. The legacy 'doms-denver' sentinel (or
      // nothing) means Denver's own area, resolved by name.
      let serviceAreaId = src.service_area_id || src.territory_id || null;
      if (!serviceAreaId || serviceAreaId === 'doms-denver') {
        const { data: biz } = await db.from('businesses').select('id').eq('slug', 'doms').single();
        // The Dom's widget may send the customer's zip instead of an area id.
        const zip = String(src.postal_code || src.zip || '').trim().slice(0, 5);
        const { data: zr } = (biz && /^\d{5}$/.test(zip)) ? await db.from('service_area_zips').select('service_area_id').eq('business_id', biz.id).eq('postal_code', zip).maybeSingle() : { data: null };
        const { data: den } = biz ? await db.from('service_areas').select('id').eq('business_id', biz.id).eq('name', 'Denver').maybeSingle() : { data: null };
        serviceAreaId = zr?.service_area_id || den?.id || null;
      }
      const result = await publicOpenSlots(db, { businessSlug: 'doms', days: src.days, serviceAreaId, crossHire: true, zip: src.postal_code || src.zip || null });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Availability lookup failed', message: err.message });
    }
  }

  // Handy Andy and Mile High are CRM-native too, but multi-metro (Handy Andy
  // has Denver/Houston/Austin/DFW; Mile High is Denver-only today but uses the
  // same shape): availability MUST be scoped to one service area (its techs +
  // timezone), so the widget passes the service_area_id it got from the zip check.
  if (NATIVE_SLUGS.includes(src.business)) {
    const serviceAreaId = src.service_area_id || src.territory_id || null;
    if (!serviceAreaId) return res.status(400).json({ error: 'service_area_id is required' });
    try {
      const db = serviceClient();
      const result = await publicOpenSlots(db, { businessSlug: src.business, days: src.days, serviceAreaId, crossHire: true, zip: src.postal_code || src.zip || null });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Availability lookup failed', message: err.message });
    }
  }

  // Zenbooker was canceled 2026-07-31 — see the matching comment in
  // api/service-area.js. Every real business is handled by the branches
  // above; nothing legitimate should ever reach here.
  return res.status(410).json({ error: 'Unknown or missing business. Zenbooker is no longer used — pass business=handy-andy, mile-high, or doms.' });
}
