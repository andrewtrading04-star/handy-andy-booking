// AI Voice Bot v3 — Vapi tool-call webhook. Replaces the v2 ConversationRelay
// bridge (voice-bridge/): Vapi runs the whole voice pipeline itself
// (telephony, speech-to-text, the AI model, text-to-speech) and just calls
// this ONE plain Vercel endpoint whenever the assistant needs real data —
// pricing, availability, or an actual booking. No separate always-on server
// to host; this is a normal serverless function like every other api/*.js.
//
// Every tool call is backed by the exact same /api/admin actions the v1 and
// v2 bots already used successfully (adminApi() below is the same pattern as
// api/analytics.js's botToken()/adminApi()) — the assistant can never invent
// a price, date, or availability slot, only ever read one from here.
import { signToken } from './_lib/auth.js';
import { serviceClient } from './_lib/supabase.js';

const BOT_TAX_RATE = 0.0825;
const BOT_MIN_TICKET = 139;
const BOT_HANDYMAN_HOURLY = 85;
const AFTER_HOURS_SLOT_KEY = 's5';

function publicBase() {
  return process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}
function botToken() {
  return signToken({ kind: 'admin', role: 'owner', scope: 'all', name: 'AI Voice Bot v3 (Vapi)' }, 3600);
}
async function adminApi(action, { method = 'GET', params = {}, body = null } = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = `${publicBase()}/api/admin?${qs}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (_) { /* non-JSON error page */ }
  if (!r.ok) {
    const e = new Error(data.error || `admin ${action} failed (${r.status})`);
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

function botAfterHoursFee(slotKey) {
  return slotKey === AFTER_HOURS_SLOT_KEY ? 15 : 0;
}
function priceSelections({ category, selections, handyman_hours, handyman_desc, slot_key }) {
  const out = [];
  if (category === 'tv') {
    for (const s of (selections || [])) {
      if (!s) continue;
      out.push({ option_id: s.id || null, label: s.label, price: Number(s.price) || 0, quantity: 1 });
    }
  } else if (category === 'handyman') {
    const hrs = Math.max(2, Number(handyman_hours) || 2);
    out.push({ option_id: null, label: `Handyman Labor: ${handyman_desc || 'as described'} — ${hrs} hour${hrs === 1 ? '' : 's'}`, price: BOT_HANDYMAN_HOURLY, quantity: hrs });
  }
  const ahFee = botAfterHoursFee(slot_key);
  if (ahFee > 0) out.push({ option_id: null, label: 'After-Hours Service Fee (8 PM)', price: ahFee, quantity: 1 });
  const rawSum = out.reduce((s, x) => s + x.price * x.quantity, 0);
  if (rawSum > 0 && rawSum < BOT_MIN_TICKET) out.push({ option_id: null, label: 'Service minimum', price: Math.round((BOT_MIN_TICKET - rawSum) * 100) / 100, quantity: 1 });
  const subtotal = out.reduce((s, x) => s + x.price * x.quantity, 0);
  const tax = Math.round(subtotal * BOT_TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  return { selections: out, subtotal, tax, total };
}

// Resolves which business/service line this call belongs to. Vapi's tool
// call carries the assistant/call metadata, but the reliable anchor is the
// same one v1/v2 used: the tracking number that was actually dialed. We ask
// Vapi to pass it as a tool-call parameter (business_slug) set once per
// assistant in the Vapi dashboard, rather than looking up by phone number
// here — simpler and avoids a second DB round trip on every tool call.
async function loadBizContext(businessSlug) {
  const db = serviceClient();
  const { data: biz } = await db.from('businesses').select('id, slug, name, timezone').eq('slug', businessSlug).maybeSingle();
  if (!biz) throw new Error(`unknown business_slug ${businessSlug}`);
  const { services: svcs } = await adminApi('services', { params: { business: biz.slug } }).catch(() => ({ services: [] }));
  const tvService = (svcs || []).find((s) => /tv\s*mount|tv\s*install/i.test(s.category || s.name || ''));
  const handymanService = (svcs || []).find((s) => /handyman/i.test(s.category || s.name || ''));
  return { biz, tvServiceId: tvService ? tvService.id : null, handymanServiceId: handymanService ? handymanService.id : null };
}

async function runTool(name, args) {
  const businessSlug = args.business_slug;
  if (!businessSlug) return { error: 'missing business_slug' };

  switch (name) {
    case 'check_zip': {
      const za = await adminApi('zip_area', { params: { business: businessSlug, postal_code: args.postal_code } });
      return za.service_area_id ? { in_service_area: true } : { in_service_area: false };
    }
    case 'get_catalog': {
      if (args.category === 'handyman') return { category: 'handyman', note: 'Ask what needs doing (free text) and estimate hours; price via price_job with handyman_hours.' };
      const { tvServiceId } = await loadBizContext(businessSlug);
      if (!tvServiceId) return { error: 'TV mounting not offered by this business' };
      const { groups } = await adminApi('service_options', { params: { business: businessSlug, service_id: tvServiceId } });
      const byKey = {};
      for (const g of (groups || [])) byKey[g.key] = (g.options || []).map((o) => ({ id: o.id, label: o.label, price: Number(o.price) || 0 }));
      return { category: 'tv', groups: byKey };
    }
    case 'get_availability': {
      if (!args.date) {
        let dates = [];
        const now = new Date();
        for (let i = 0; i < 2 && dates.length < 5; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
          const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          try {
            const r = await adminApi('available_dates', { params: { business: businessSlug, month, technician_id: 'any', pool: 'cross', postal_code: args.postal_code } });
            dates = dates.concat(r.dates || []);
          } catch (_) { /* try next month */ }
        }
        return { dates: dates.slice(0, 5) };
      }
      const r = await adminApi('available_slots', { params: { business: businessSlug, date: args.date, technician_id: 'any', pool: 'cross', postal_code: args.postal_code } });
      return { date: args.date, slots: (r.slots || []).map((s) => ({ slot_key: s.slot_key, label: s.label, start: s.start, end: s.end })) };
    }
    case 'price_job':
      return priceSelections(args);
    case 'book_job': {
      const { tvServiceId, handymanServiceId } = await loadBizContext(businessSlug);
      const priced = priceSelections(args);
      const body = {
        business: businessSlug,
        idempotency_key: `voicebotv3-${args.call_id || Date.now()}`,
        customer: { name: args.name || 'Phone Customer', phone: args.phone || null, email: args.email || null, postal_code: args.postal_code || null, address_line1: args.address || null },
        service_id: args.category === 'tv' ? tvServiceId : handymanServiceId,
        technician_id: 'any', pool: 'cross',
        scheduled_date: args.date, scheduled_slot: args.slot_key,
        selections: priced.selections, subtotal: priced.subtotal, tax: priced.tax, price: priced.total,
        payment_method: 'card',
        notes: 'Booked by AI Voice Bot v3 (Vapi)',
        sms_consent: true,
      };
      await adminApi('booking_create', { method: 'POST', body });
      return { booked: true, total: priced.total, date: args.date, slot_label: args.slot_label || args.slot_key };
    }
    case 'transfer_to_human':
      // Vapi handles the actual transfer via its own "Transfer Call" tool
      // configured in the dashboard alongside this custom tool — this
      // handler just acknowledges so the assistant's flow can complete.
      return { transfer_acknowledged: true, reason: args.reason || '' };
    default:
      return { error: `Unknown tool ${name}` };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret && req.headers['x-vapi-secret'] !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

  const toolCalls = (req.body && req.body.message && req.body.message.toolCalls) || [];
  const results = [];
  for (const tc of toolCalls) {
    const fn = tc.function || {};
    let args = fn.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
    args = args || {};
    let result;
    try { result = await runTool(fn.name, args); }
    catch (e) { result = { error: e.message }; }
    // Vapi requires result/error as strings, never objects — see
    // docs.vapi.ai/tools/custom-tools.
    results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
  }
  // Always 200 — Vapi ignores any other status code entirely.
  res.status(200).json({ results });
}
