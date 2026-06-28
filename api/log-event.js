import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id, event_type, step_name, value, device_type, traffic_source, city, state, zip_code, error_message, customer_name } = req.body;

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'Missing Supabase credentials' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const row = {
      session_id,
      event_type,
      step_name,
      value,
      device_type,
      browser: req.headers['user-agent'],
      traffic_source,
      city,
      state,
      zip_code,
      widget: 'handy-andy',
      error_message,
    };
    // Customer name (once they enter it on the form). Best-effort: drop it and
    // retry if the column isn't applied yet, so event logging never breaks.
    if (customer_name) row.customer_name = String(customer_name).slice(0, 120);
    let { error } = await supabase.from('events').insert([row]);
    if (error && /customer_name/.test(error.message || '')) {
      delete row.customer_name;
      ({ error } = await supabase.from('events').insert([row]));
    }
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
