import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id, event_type, step_name, value, device_type, traffic_source, city, state, zip_code, error_message } = req.body;

  try {
    const { error } = await supabase.from('events').insert([
      {
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
      },
    ]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
