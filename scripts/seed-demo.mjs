// scripts/seed-demo.mjs
// ============================================================================
// Seeds a DEMO database with 100% fictional data for a sales sandbox.
// Renames the two seeded businesses to Camelback / Gold Coast TV Mounting and
// fills the schedule, dashboard, payroll, and estimates with fake bookings,
// customers, techs, and reviews. No real names, phones, addresses, or money.
//
// SAFE TO RUN ONLY ON A THROWAWAY DEMO PROJECT. It deletes and rewrites the
// bookings/customers/estimates for both businesses. Never point it at production.
//
// Run:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-demo.mjs
//   or: node --env-file=.env.demo scripts/seed-demo.mjs
// Re-runnable: it clears prior demo rows first, so run it as many times as you like.
// ============================================================================
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const db = createClient(URL, KEY, { db: { schema: 'app' }, auth: { persistSession: false } });

// ── Config: the two demo businesses (keep the internal slugs; only names change)
const BIZ = {
  'handy-andy': {
    name: 'Camelback TV Mounting', tz: 'America/Phoenix',
    url: 'https://camelbacktv.example.com', email: 'office@camelbacktv.example.com', phone: '(602) 555-0142',
    areas: [['Phoenix', 'AZ', 'America/Phoenix'], ['Scottsdale', 'AZ', 'America/Phoenix'], ['Tempe', 'AZ', 'America/Phoenix']],
    techs: ['Marcus Bell', 'Diego Ortiz', 'Ryan Cole', 'Tyler Fox'],
    area_code: '602', secretary: 'Sam Rivera',
    cities: [['Phoenix', '85018'], ['Scottsdale', '85251'], ['Tempe', '85281']], state: 'AZ',
  },
  'doms': {
    name: 'Gold Coast TV Mounting', tz: 'America/Chicago',
    url: 'https://goldcoasttv.example.com', email: 'office@goldcoasttv.example.com', phone: '(312) 555-0177',
    areas: [['Chicago', 'IL', 'America/Chicago']],
    techs: ['Andre Silva', 'Chris Nolan', 'Priya Shah'],
    area_code: '312', secretary: 'Jordan Lee',
    cities: [['Chicago', '60610'], ['Evanston', '60201']], state: 'IL',
  },
};
const OWNER_NAME = 'Alex Carter';

const FIRST = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'Lucas', 'Mia', 'Jackson', 'Harper', 'Aiden', 'Ella', 'Grayson', 'Chloe', 'Leo', 'Nora', 'Owen', 'Zoe', 'Caleb', 'Lily', 'Wyatt', 'Aria'];
const LAST = ['Nguyen', 'Patel', 'Kim', 'Reyes', 'Bennett', 'Foster', 'Sullivan', 'Hughes', 'Barrett', 'Chen', 'Delgado', 'Meyer', 'Osborne', 'Fletcher', 'Vargas', 'Snyder', 'Bishop', 'Cross', 'Lane', 'Marsh', 'Frost', 'Wade', 'Booth', 'Yates', 'Hale'];
const STREETS = ['Camelback Rd', 'Maple Ave', 'Oak St', 'Sunset Blvd', 'Willow Ln', 'Birch Ct', 'Cedar Way', 'Palm Dr', 'Aspen St', 'Juniper Rd', 'Lakeview Dr', 'Cactus Ave', 'Desert Rose Ln', 'Harbor St', 'Lincoln Ave'];
const SIZES = [['32" Or Less', 99], ['33"-59"', 109], ['60"-69"', 119], ['70"-84"', 149], ['85"-97"', 179]];
const ADDONS = [['Soundbar installation', 50], ['Hide wires behind the wall (in-wall)', 75], ['Hide wires outside the wall (cord cover)', 25], ['LED accent lights behind TV', 50], ['Dismount & haul away old TV', 35]];
const REVIEWS = ['Fantastic job, super clean and fast!', 'On time and professional. Highly recommend.', 'Looks amazing on the wall. Thank you!', 'Great communication and tidy work.', 'Wires are perfectly hidden. Very happy.'];

let SEED = 20260705;
const rand = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const pad = (n) => String(n).padStart(2, '0');
const phoneFor = (code, i) => `(${code}) 555-${pad(1000 + i).slice(-4)}`;

async function main() {
  console.log('Seeding demo data…');
  const { data: bizRows, error: bizErr } = await db.from('businesses').select('id, slug').in('slug', Object.keys(BIZ));
  if (bizErr) throw bizErr;
  if (!bizRows?.length) throw new Error('No businesses found — apply the migrations (0001+) first.');
  const idBySlug = Object.fromEntries(bizRows.map(b => [b.slug, b.id]));

  // Owner display name (staff_users) → fictional.
  await db.from('staff_users').update({ name: OWNER_NAME }).eq('role', 'owner');

  let custPhone = 0;
  for (const slug of Object.keys(BIZ)) {
    const bizId = idBySlug[slug]; if (!bizId) continue;
    const cfg = BIZ[slug];
    console.log(`\n=== ${cfg.name} (${slug}) ===`);

    // 1) Business identity
    await db.from('businesses').update({ name: cfg.name, url: cfg.url, support_email: cfg.email, support_phone: cfg.phone, timezone: cfg.tz }).eq('id', bizId);

    // 2) Service areas (rename existing in place for flavor)
    const { data: areas } = await db.from('service_areas').select('id, name').eq('business_id', bizId).order('name');
    for (let i = 0; i < (areas || []).length && i < cfg.areas.length; i++) {
      const [name, state, tz] = cfg.areas[i];
      await db.from('service_areas').update({ name, state, timezone: tz }).eq('id', areas[i].id);
    }
    const areaIds = (areas || []).map(a => a.id);

    // 3) Secretary staff name → fictional
    await db.from('staff_users').update({ name: cfg.secretary }).eq('business_id', bizId).neq('role', 'owner');

    // 4) Technicians: rename existing to fictional + set phone + PIN 1234 + color
    const { data: techs } = await db.from('technicians').select('id, name').eq('business_id', bizId).order('created_at');
    const colors = ['#2563eb', '#f97316', '#16a34a', '#db2777', '#7c3aed'];
    const techIds = [];
    for (let i = 0; i < cfg.techs.length; i++) {
      const name = cfg.techs[i];
      let tid = techs && techs[i] ? techs[i].id : null;
      const phone = phoneFor(cfg.area_code, 100 + i);
      if (tid) {
        await db.from('technicians').update({ name, phone, email: `${name.split(' ')[0].toLowerCase()}@${slug}.example.com`, color: colors[i % colors.length], active: true, status: 'off' }).eq('id', tid);
      } else {
        const { data: ins } = await db.from('technicians').insert({ business_id: bizId, name, phone, color: colors[i % colors.length], active: true }).select('id').single();
        tid = ins?.id;
      }
      if (tid) { techIds.push(tid); await db.rpc('set_technician_pin', { p_id: tid, p_pin: '1234' }); }
    }

    // Service id for this business's TV Installation
    const { data: svc } = await db.from('services').select('id').eq('business_id', bizId).limit(1).maybeSingle();
    const serviceId = svc?.id || null;

    // 5) Clean prior demo rows (idempotent re-runs)
    await db.from('bookings').delete().eq('business_id', bizId);
    await db.from('customers').delete().eq('business_id', bizId);
    await db.from('estimates').delete().eq('business_id', bizId);

    // 6) Customers
    const customers = [];
    for (let i = 0; i < 26; i++) {
      const fn = pick(FIRST), ln = pick(LAST);
      const [city, zip] = pick(cfg.cities);
      customers.push({
        business_id: bizId, name: `${fn} ${ln}`, first_name: fn, last_name: ln,
        phone: phoneFor(cfg.area_code, custPhone++), email: `${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`,
        address_line1: `${100 + Math.floor(rand() * 8900)} ${pick(STREETS)}`, city, state: cfg.state, postal_code: zip,
      });
    }
    const { data: custRows, error: custErr } = await db.from('customers').insert(customers).select('id, name, phone, email, address_line1, city, state, postal_code');
    if (custErr) throw custErr;

    // 7) Bookings across -14 … +14 days, varied statuses; line items; some reviews
    const now = new Date();
    let made = 0, revenue = 0;
    for (let d = -14; d <= 14; d++) {
      const perDay = 1 + Math.floor(rand() * 3);           // 1–3 jobs/day
      for (let j = 0; j < perDay; j++) {
        const c = pick(custRows);
        const start = new Date(now); start.setDate(now.getDate() + d); start.setHours(9 + Math.floor(rand() * 8), rand() < 0.5 ? 0 : 30, 0, 0);
        const end = new Date(start.getTime() + 90 * 60000);
        const [sizeLabel, sizePrice] = pick(SIZES);
        const withAddon = rand() < 0.5;
        const [addLabel, addPrice] = withAddon ? pick(ADDONS) : [null, 0];
        const price = sizePrice + addPrice;
        const tid = pick(techIds);
        const past = d < 0, today = d === 0;
        const status = past ? 'completed' : today ? pick(['assigned', 'on_the_way', 'in_progress']) : pick(['confirmed', 'assigned', 'assigned']);
        const reviewed = past && rand() < 0.55;
        const areaId = areaIds.length ? pick(areaIds) : null;
        const { data: bk } = await db.from('bookings').insert({
          business_id: bizId, customer_id: c.id, technician_id: tid, service_id: serviceId, service_area_id: areaId,
          status, source: pick(['widget', 'manual', 'phone']),
          scheduled_at: start.toISOString(), scheduled_end: end.toISOString(), duration_minutes: 90,
          subtotal: price, price, payment_status: past ? 'paid' : 'card_on_file',
          address_line1: c.address_line1, city: c.city, state: c.state, postal_code: c.postal_code,
          completed_at: past ? end.toISOString() : null,
          review_rating: reviewed ? (rand() < 0.8 ? 5 : 4) : null,
          review_text: reviewed ? pick(REVIEWS) : null,
          reviewed_at: reviewed ? end.toISOString() : null,
        }).select('id').single();
        if (bk?.id) {
          const items = [{ booking_id: bk.id, business_id: bizId, kind: 'service', name: `TV Size: ${sizeLabel}`, quantity: 1, unit_price: sizePrice, line_total: sizePrice }];
          if (withAddon) items.push({ booking_id: bk.id, business_id: bizId, kind: 'addon', name: addLabel, quantity: 1, unit_price: addPrice, line_total: addPrice });
          await db.from('booking_line_items').insert(items);
          made++; if (past) revenue += price;
        }
      }
    }
    console.log(`  ${custRows.length} customers, ${made} bookings (past revenue ~$${revenue}), ${techIds.length} techs w/ PIN 1234`);

    // 8) Estimates — a couple with quotes + upsells, one approved
    const e1 = pick(custRows), e2 = pick(custRows), e3 = pick(custRows);
    const upsells = ADDONS.slice(0, 3).map((a, i) => ({ id: 'u' + i, description: a[0], qty: 1, unit_price: a[1], tech_pay: Math.round(a[1] * 0.5), badge: '', blurb: '', default_on: false }));
    await db.from('estimates').insert([
      { business_id: bizId, customer_name: e1.name, customer_phone: e1.phone, customer_email: e1.email, service_label: 'TV mount over fireplace', description: 'Customer wants a 65" mounted above a gas fireplace with wires hidden.', status: 'new', source: 'widget', sms_consent: true },
      { business_id: bizId, customer_name: e2.name, customer_phone: e2.phone, customer_email: e2.email, service_label: 'Two-TV install', description: 'Living room + bedroom mounts.', status: 'contacted', source: 'widget', sms_consent: true,
        line_items: [{ description: '65" TV mount', qty: 1, unit_price: 149 }, { description: '50" TV mount', qty: 1, unit_price: 109 }], tax_rate: 0.0875, upsells },
      { business_id: bizId, customer_name: e3.name, customer_phone: e3.phone, customer_email: e3.email, service_label: 'Soundbar + mount', description: 'Approved job.', status: 'scheduled', source: 'widget', sms_consent: true,
        line_items: [{ description: '70" TV mount', qty: 1, unit_price: 149 }], tax_rate: 0.0875, upsells,
        approved_at: new Date(now.getTime() - 2 * 86400000).toISOString(),
        accepted_upsells: [{ id: 'u0', description: ADDONS[0][0], qty: 1, unit_price: ADDONS[0][1], tech_pay: 25 }],
        approved_total: Math.round((149 + ADDONS[0][1]) * 1.0875 * 100) / 100 },
    ]);
    console.log('  3 estimates (1 new, 1 sent w/ upsells, 1 approved)');
  }
  console.log('\n✅ Demo seed complete. Log in as owner with your demo ADMIN_PASSWORD; techs use their phone + PIN 1234.');
}

main().then(() => process.exit(0)).catch(e => { console.error('SEED FAILED:', e.message || e); process.exit(1); });
