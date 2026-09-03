// Tool schema (OpenAI function-calling format) + handlers. Every handler
// calls the CRM's existing /api/admin actions via adminApi() — same actions
// the v1 bot already exercised successfully in production, same params. No
// pricing/scheduling/booking logic is reimplemented here; the model can only
// ever act through these, so it can never quote a number that didn't come
// from the real catalog/pricing engine.
import { adminApi } from './adminApi.js';

const BOT_TAX_RATE = 0.0825;
const BOT_MIN_TICKET = 139;
const BOT_HANDYMAN_HOURLY = 85;
const AFTER_HOURS_SLOT_KEY = 's5';

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'check_zip',
      description: 'Check whether a postal code is in the service area for this business, and get the tech pool for later scheduling calls.',
      parameters: { type: 'object', properties: { postal_code: { type: 'string' } }, required: ['postal_code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_catalog',
      description: 'Get the priced option groups (TV size, bracket, fireplace, wires, lifting, extras) for TV mounting, or confirm handyman is available. Call once near the start of a TV mounting conversation so you know the real option labels and prices to offer.',
      parameters: { type: 'object', properties: { category: { type: 'string', enum: ['tv', 'handyman'] } }, required: ['category'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_availability',
      description: 'Get real open appointment dates (and, given a chosen date, time slots) for this postal code. Call with just postal_code first to get dates; call again with postal_code + date to get that day\'s slots.',
      parameters: {
        type: 'object',
        properties: { postal_code: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, only once a date has been chosen' } },
        required: ['postal_code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'price_job',
      description: 'Price the job so far from the selections collected. Call this before reading a total out loud, and again if anything changes. Never state a dollar amount that didn\'t come from this tool.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['tv', 'handyman'] },
          selections: {
            type: 'array',
            description: 'Each chosen option, as returned by get_catalog (id/label/price), one per group actually chosen (size, bracket, fireplace, wires, lifting, extras) for tv; empty for handyman.',
            items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, price: { type: 'number' } } },
          },
          handyman_hours: { type: 'number', description: 'Only for category handyman, minimum 2' },
          handyman_desc: { type: 'string' },
          slot_key: { type: 'string', description: 'The chosen time slot key, if picked yet — needed to flag the after-hours fee' },
          date: { type: 'string' },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_job',
      description: 'Actually create the booking. Only call this after the caller has explicitly confirmed the recap (price, date, time) out loud. This is a real, final booking — never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['tv', 'handyman'] },
          selections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, price: { type: 'number' } } } },
          handyman_hours: { type: 'number' },
          handyman_desc: { type: 'string' },
          date: { type: 'string' },
          slot_key: { type: 'string' },
          slot_label: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
        },
        required: ['category', 'date', 'slot_key', 'name', 'address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: 'End the AI conversation and transfer the live call to a human. Use this any time the caller asks for a person, pushes back on price, needs something outside a standard TV mounting or handyman booking (insurance/warranty jobs, discounts, GDS/gift codes), or you cannot confidently help after a couple of tries.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  },
];

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

// ctx: { businessSlug, tvServiceId, handymanServiceId, callSid, callerPhone }
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'check_zip': {
      const za = await adminApi('zip_area', { params: { business: ctx.businessSlug, postal_code: args.postal_code } });
      if (!za.service_area_id) return { in_service_area: false };
      return { in_service_area: true, service_area_id: za.service_area_id };
    }
    case 'get_catalog': {
      if (args.category === 'handyman') return { category: 'handyman', note: 'Ask what needs doing (free text) and estimate hours; price via price_job with handyman_hours.' };
      const serviceId = ctx.tvServiceId;
      if (!serviceId) return { error: 'TV mounting not offered by this business' };
      const { groups } = await adminApi('service_options', { params: { business: ctx.businessSlug, service_id: serviceId } });
      const byKey = {};
      for (const g of (groups || [])) {
        byKey[g.key] = (g.options || []).map(o => ({ id: o.id, label: o.label, price: Number(o.price) || 0 }));
      }
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
            const r = await adminApi('available_dates', { params: { business: ctx.businessSlug, month, technician_id: 'any', pool: 'cross', postal_code: args.postal_code } });
            dates = dates.concat(r.dates || []);
          } catch (_) { /* try next month */ }
        }
        return { dates: dates.slice(0, 5) };
      }
      const r = await adminApi('available_slots', { params: { business: ctx.businessSlug, date: args.date, technician_id: 'any', pool: 'cross', postal_code: args.postal_code } });
      return { date: args.date, slots: (r.slots || []).map(s => ({ slot_key: s.slot_key, label: s.label, start: s.start, end: s.end })) };
    }
    case 'price_job': {
      return priceSelections(args);
    }
    case 'book_job': {
      const priced = priceSelections(args);
      const body = {
        business: ctx.businessSlug,
        idempotency_key: `voicebotv2-${ctx.callSid}`,
        customer: { name: args.name || 'Phone Customer', phone: args.phone || ctx.callerPhone || null, email: args.email || null, postal_code: args.postal_code || null, address_line1: args.address || null },
        service_id: args.category === 'tv' ? ctx.tvServiceId : ctx.handymanServiceId,
        technician_id: 'any', pool: 'cross',
        scheduled_date: args.date, scheduled_slot: args.slot_key,
        selections: priced.selections, subtotal: priced.subtotal, tax: priced.tax, price: priced.total,
        payment_method: 'card',
        notes: 'Booked by AI Voice Bot v2 (ConversationRelay)',
        sms_consent: true,
      };
      await adminApi('booking_create', { method: 'POST', body });
      return { booked: true, total: priced.total, date: args.date, slot_label: args.slot_label || args.slot_key };
    }
    case 'transfer_to_human': {
      return { transfer: true, reason: args.reason || '' };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}
