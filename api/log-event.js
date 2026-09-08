import { serviceClientPublic, serviceClient } from './_lib/supabase.js';
import { isBotUserAgent } from './_lib/bot-filter.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { session_id, event_type, step_name, value, device_type, traffic_source, city, state, zip_code, error_message, customer_name, widget } = req.body;

  // Crawlers, monitors and our own tooling never become customers, so they are
  // dropped here rather than filtered in a dozen downstream queries. Left as a
  // 200: the widget must not treat this as an error and retry, and a crawler
  // executing our JS should get the same boring answer a customer does.
  // Found via precisiontvinstallation.com / tvmountingdenver.com, where this
  // traffic was ~100 sessions each and made a dead funnel look like a broken one.
  if (isBotUserAgent(req.headers['user-agent'])) {
    return res.status(200).json({ ok: true, skipped: 'bot' });
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Missing Supabase credentials' });
    }

    // Which widget produced this event, validated against app.businesses.
    // analytics_config (migration 0106) rather than a hardcoded slug list —
    // a business is trackable the moment its config row exists, no deploy.
    // The handyman-estimate widget for HA/Doms is a fixed literal tag,
    // independent of its business's own funnel_backend (Doms's booking
    // widget is renamed 'doms-tv'; 'doms-handyman' is not).
    //
    // No `widget` field at all is the true LEGACY case — the original
    // TV-mounting booking widget predates this field entirely, so its
    // absence really does mean Handy Andy, same as always.
    //
    // An explicit widget value that matches nothing used to fall back
    // silently to 'handy-andy' too — which meant a business that was never
    // wired up (found 2026-09-07: the LA trio) had its real traffic quietly
    // counted as Handy Andy's, with nothing anywhere to reveal it was
    // happening. That case now lands in a visibly-separate 'unrecognized'
    // bucket instead: still captured, never misattributed to a business
    // that didn't earn it.
    const db = serviceClient();
    let widgetTag;
    if (!widget) {
      widgetTag = 'handy-andy';
    } else if (widget === 'handy-andy-handyman' || widget === 'doms-handyman') {
      widgetTag = widget;
    } else {
      const { data } = await db.from('businesses')
        .select('id').eq('active', true).eq('analytics_config->>funnel_backend', widget).maybeSingle();
      widgetTag = data ? widget : 'unrecognized';
    }

    // Service-role (public schema) so the analytics `events` table can have RLS
    // FORCED on — the public anon key must never touch it directly.
    const supabase = serviceClientPublic();

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
      widget: widgetTag,
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
