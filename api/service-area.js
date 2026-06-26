// /api/service-area.js
// Looks up which Zenbooker territory serves a zip code.
// Doms (business=doms) is native: it answers from the CRM's service_area_zips
// table instead of Zenbooker and returns the per-zip travel surcharge.
import { serviceClient } from './_lib/supabase.js';

// Native CRM zip check for Doms — no Zenbooker. Returns whether the zip is
// covered, the per-zip surcharge, and a metro default city/state.
async function domsServiceArea(req, res) {
  const zip = String((req.body && (req.body.zip || req.body.postal_code)) || '').trim();
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // TEMPORARY read-only diagnostic — investigate a tech double-booking. Remove after use.
  if (req.method === 'GET' && req.query.debug === 'tech') {
    if (req.query.token !== 'tech-9k3') return res.status(403).json({ error: 'forbidden' });
    try {
      const db = serviceClient();
      const TZ = 'America/Denver';
      const loc = (ts) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
      const dow = (ts) => ts ? new Date(ts).toLocaleString('en-US', { timeZone: TZ, weekday: 'long' }) : null;
      const { data: biz } = await db.from('businesses').select('id,timezone').eq('slug', 'handy-andy').single();
      const { data: bks } = await db.from('bookings')
        .select('id, scheduled_at, scheduled_end, status, technician_id, secondary_technician_id, customer_id, created_at, source')
        .eq('business_id', biz.id).order('created_at', { ascending: false }).limit(15);
      const custIds = [...new Set((bks || []).map(b => b.customer_id).filter(Boolean))];
      const techIds = [...new Set((bks || []).flatMap(b => [b.technician_id, b.secondary_technician_id]).filter(Boolean))];
      const { data: custs } = custIds.length ? await db.from('customers').select('id,name').in('id', custIds) : { data: [] };
      const { data: techs } = techIds.length ? await db.from('technicians').select('id,name').in('id', techIds) : { data: [] };
      const cmap = Object.fromEntries((custs || []).map(c => [c.id, c.name]));
      const tmap = Object.fromEntries((techs || []).map(t => [t.id, t.name]));
      const recent = (bks || []).map(b => ({ id: b.id, customer: cmap[b.customer_id], status: b.status, source: b.source,
        local: loc(b.scheduled_at), day: dow(b.scheduled_at), scheduled_at: b.scheduled_at,
        tech: tmap[b.technician_id] || null, second_tech: tmap[b.secondary_technician_id] || null, created: b.created_at }));
      // Gregory: availability + all his bookings
      const { data: greg } = await db.from('technicians').select('id,name,active').eq('business_id', biz.id).ilike('name', '%greg%').maybeSingle();
      let gregory = null;
      if (greg) {
        const { data: avail } = await db.from('technician_availability').select('day_of_week,slot_key').eq('technician_id', greg.id);
        const { data: gb } = await db.from('bookings').select('id,scheduled_at,status,technician_id,secondary_technician_id')
          .or(`technician_id.eq.${greg.id},secondary_technician_id.eq.${greg.id}`).order('scheduled_at', { ascending: false }).limit(20);
        gregory = { id: greg.id, name: greg.name, active: greg.active,
          availability: (avail || []).map(a => ({ day_of_week: a.day_of_week, slot_key: a.slot_key })),
          bookings: (gb || []).map(b => ({ id: b.id, local: loc(b.scheduled_at), day: dow(b.scheduled_at), status: b.status, role: b.technician_id === greg.id ? 'primary' : 'second' })) };
      }
      return res.status(200).json({ timezone: biz.timezone, recent_bookings: recent, gregory });
    } catch (e) { return res.status(500).json({ error: e.message, stack: e.stack }); }
  }

  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Doms is CRM-native — branch before any Zenbooker work.
  if (req.body && req.body.business === 'doms') return domsServiceArea(req, res);

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const zip = (req.body && (req.body.zip || req.body.postal_code)) || '';
  if (!zip) return res.status(400).json({ error: 'zip is required' });

  // Hard-code overrides for zips that should always be accepted in specific territories
  const ZIP_OVERRIDES = {
    '80223': { territory_id: '1685582903241x973573877706522600', territory_name: 'Denver #1', timezone: 'America/Denver', city: 'Denver', state: 'CO' },
  };

  if (ZIP_OVERRIDES[zip]) {
    const ov = ZIP_OVERRIDES[zip];
    return res.status(200).json({
      in_service_area: true,
      territory_id:    ov.territory_id,
      territory_name:  ov.territory_name,
      timezone:        ov.timezone,
      service_ids:     [], // Service IDs not needed for override
      city:            ov.city,
      state:           ov.state,
      lat:             null,
      lng:             null,
    });
  }

  try {
    const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
    url.searchParams.set('postal_code', String(zip));

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ZBK_KEY}` },
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || 'Zenbooker error', details: data });
    }

    return res.status(200).json({
      in_service_area: !!data.in_service_area,
      territory_id:    data.service_territory?.id || null,
      territory_name:  data.service_territory?.name || null,
      timezone:        data.service_territory?.timezone || null,
      service_ids:     data.service_territory?.service_ids || [],
      city:            data.customer_location?.components?.city || null,
      state:           data.customer_location?.components?.state || null,
      lat:             data.customer_location?.coordinates?.lat || null,
      lng:             data.customer_location?.coordinates?.lng || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Service area check failed', message: err.message });
  }
}
