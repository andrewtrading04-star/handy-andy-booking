#!/usr/bin/env node
// Add test bracket delivery data for testing the inventory alert system
import { serviceClient } from '../api/_lib/supabase.js';

const db = serviceClient();

async function addTestBrackets() {
  // Find handy-andy business
  const { data: biz, error: bizErr } = await db.from('businesses')
    .select('id').eq('slug', 'handy-andy').single();

  if (bizErr || !biz) {
    throw new Error(`business "handy-andy" not found: ${bizErr?.message || 'not found'}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Insert test delivery: 4 full-motion brackets from order #2000149-89433822
  const { data, error } = await db.from('bracket_purchases').insert({
    business_id: biz.id,
    walmart_order_num: '2000149-89433822',
    flat_qty: 0,
    tilting_qty: 0,
    full_motion_qty: 4,
    status: 'delivered',
    order_date: '2026-06-25',
    delivered_date: today,
  }).select();

  if (error) {
    throw new Error(`insert failed: ${error.message}`);
  }

  console.log('✓ Test bracket delivery added:', data[0]);
}

addTestBrackets().catch(e => {
  console.error('✗ Error:', e.message);
  process.exit(1);
});
