import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('❌ Missing env vars');
  process.exit(1);
}

const db = createClient(supabaseUrl, serviceKey);

async function createBooking(businessSlug, bizName) {
  try {
    console.log(`\n📝 Creating test booking for ${bizName}...`);

    // Get business
    const { data: biz, error: bizErr } = await db.from('businesses')
      .select('id').eq('slug', businessSlug).single();
    if (bizErr || !biz) throw new Error(`Business not found: ${businessSlug}`);

    // Get random active tech
    const { data: techs, error: techsErr } = await db.from('technicians')
      .select('id, name').eq('business_id', biz.id).eq('active', true);
    if (techsErr || !techs || !techs.length) throw new Error('No active techs');
    const tech = techs[Math.floor(Math.random() * techs.length)];

    // Get the TV Mounting service for this business
    const { data: tvService, error: svcErr } = await db.from('services')
      .select('id').eq('business_id', biz.id).eq('name', 'TV Mounting').single();
    if (svcErr || !tvService) throw new Error('TV Mounting service not found');

    // Create customer
    const email = `test-${Date.now()}-${Math.random().toString(36).slice(7)}@example.com`;
    const name = `Test Customer ${Math.floor(Math.random() * 10000)}`;
    const phone = `(555) ${Math.floor(Math.random() * 9000) + 1000}`;

    const { data: cust, error: custErr } = await db.from('customers').insert({
      business_id: biz.id,
      name, email, phone,
      address_line1: '123 Main St',
      city: 'Denver',
      state: 'CO',
      postal_code: '80202',
    }).select().single();
    if (custErr || !cust) throw new Error('Failed to create customer');

    // Create booking for tomorrow at 10am
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    const scheduledAt = tomorrow.toISOString();
    const scheduledEnd = new Date(tomorrow.getTime() + 2 * 60 * 60 * 1000).toISOString();

    const { data: booking, error: bookErr } = await db.from('bookings').insert({
      business_id: biz.id,
      customer_id: cust.id,
      technician_id: tech.id,
      service_id: tvService.id,
      scheduled_at: scheduledAt,
      scheduled_end: scheduledEnd,
      status: 'confirmed',
      payment_status: 'unpaid',
      price: 155,
      customer_name: name,
      customer_phone: phone,
      customer_email: email,
      address_line1: '123 Main St',
      city: 'Denver',
      state: 'CO',
      postal_code: '80202',
    }).select().single();
    if (bookErr || !booking) throw new Error('Failed to create booking');

    // Add line items
    await db.from('booking_line_items').insert([
      { booking_id: booking.id, business_id: biz.id, name: 'TV Mount Installation', quantity: 1, unit_price: 75, line_total: 75 },
      { booking_id: booking.id, business_id: biz.id, name: 'Wall Prep & Cable', quantity: 1, unit_price: 80, line_total: 80 },
    ]);

    console.log(`  ✅ Booking ID: ${booking.id}`);
    console.log(`     Tech: ${tech.name}`);
    console.log(`     Customer: ${name}`);
    console.log(`     Scheduled: ${tomorrow.toLocaleString()}`);
    console.log(`     Price: $155`);

  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
    process.exit(1);
  }
}

await createBooking('handy-andy', 'Handy Andy');
await createBooking('doms', 'Doms');

console.log('\n✅ Done!\n');
