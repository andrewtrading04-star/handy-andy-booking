import { createClient } from '@supabase/supabase-js';

let _client = null;
export function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  _client = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'app' } });
  return _client;
}

export async function sessionUpsert(row) {
  await db().from('voice_bot_sessions').upsert(row, { onConflict: 'call_sid' });
}
export async function sessionSave(callSid, patch) {
  await db().from('voice_bot_sessions').update({ ...patch, updated_at: new Date().toISOString() }).eq('call_sid', callSid);
}
export async function trackingNumberByPhone(phone) {
  const { data } = await db().from('tracking_numbers')
    .select('phone, label, business_slug, market, forward_to, ring_seconds, record_calls, after_hours_forward_to, hours_start, hours_end, hours_timezone')
    .eq('phone', phone).maybeSingle();
  return data || null;
}
export async function businessBySlug(slug) {
  const { data } = await db().from('businesses').select('id, slug, name, timezone').eq('slug', slug).maybeSingle();
  return data || null;
}
