// /api/slots.js
// Returns bookable appointment times. Handy Andy proxies Zenbooker's timeslots;
// Doms (business=doms) is native — it computes open slots from the CRM's own
// technician availability minus existing bookings, no Zenbooker involved.
import { serviceClient } from './_lib/supabase.js';
import { publicOpenSlots } from './_lib/availability.js';

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
      const result = await publicOpenSlots(db, { businessSlug: 'doms', days: src.days, crossHire: true });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Availability lookup failed', message: err.message });
    }
  }

  // Handy Andy is CRM-native too, but multi-metro: availability MUST be scoped to
  // one service area (its techs + timezone), so the widget passes the
  // service_area_id it got from the zip check.
  if (src.business === 'handy-andy') {
    const serviceAreaId = src.service_area_id || src.territory_id || null;
    if (!serviceAreaId) return res.status(400).json({ error: 'service_area_id is required' });
    try {
      const db = serviceClient();
      const result = await publicOpenSlots(db, { businessSlug: 'handy-andy', days: src.days, serviceAreaId, crossHire: true });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Availability lookup failed', message: err.message });
    }
  }

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const { territory_id, duration, date, days, lat, lng, min_providers_needed } = src;

  if (!territory_id) return res.status(400).json({ error: 'territory_id is required' });
  if (!duration)     return res.status(400).json({ error: 'duration (minutes) is required' });

  try {
    const url = new URL('https://api.zenbooker.com/v1/scheduling/timeslots');
    url.searchParams.set('territory', territory_id);
    url.searchParams.set('date',      date || new Date().toISOString().slice(0, 10));
    url.searchParams.set('duration',  String(duration));
    url.searchParams.set('days',      String(days || 14));
    if (min_providers_needed) url.searchParams.set('min_providers_needed', String(min_providers_needed));
    if (lat) url.searchParams.set('lat', String(lat));
    if (lng) url.searchParams.set('lng', String(lng));

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ZBK_KEY}` },
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || 'Zenbooker error', details: data });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Timeslot lookup failed', message: err.message });
  }
}
