// Tags "logo shots" — a finished mount photographed with the company logo up
// on the customer's TV screen. Those are the photos worth posting, and the
// tech app already coaches techs through producing them (#logoHelpModal in
// public/tech.html). This is the other half: finding them afterwards without
// scrolling the whole Photos tab.
//
// Runs from a cron (api/migrate.js?action=photo_logo_scan, twice a day) over
// booking_photos rows that have never been scanned. Every photo is looked at
// exactly once and the verdict is stored — logo_shot true/false plus a one-line
// reason — so the gallery filter is a plain indexed query, not a live API call.
//
// Deliberately Haiku with a tiny max_tokens: this is a yes/no question about a
// very distinctive object (a bright multi-colored splash logo lighting up an
// otherwise-dark TV panel), not an analysis task. At ~15 new photos a day the
// running cost is negligible, and a backfill of the whole table is a few cents.
//
// Never throws on a single bad photo. A 404'd URL or a model hiccup leaves
// logo_scanned_at null so the next run retries it; only a real verdict is
// written. If ANTHROPIC_API_KEY is unset the whole thing no-ops, exactly like
// the voice bot's Claude fallback in api/analytics.js.

import { serviceClient } from './supabase.js';

const MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 5;     // 5 in flight keeps a 40-photo run well inside the function timeout
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 300;

// The logo is the same artwork on both companies' assets: a paint-splash color
// wheel with the brand name under it. The prompt names the failure modes that
// actually occur in these photos — a TV showing ordinary content, a TV that's
// off, or the logo appearing on a van/shirt/business card rather than the
// screen — because those are what a naive "is the logo visible" question gets
// wrong. Answer shape is pinned so parsing stays trivial.
const PROMPT = [
  'You are reviewing a TV-mounting job photo.',
  '',
  'Question: is OUR company logo displayed ON THE TV SCREEN itself?',
  '',
  'Our logo is a single specific piece of artwork: a multi-coloured paint-splash',
  'swirl / spiral (pink, orange, yellow, green, blue) with paint droplets flying',
  'off it, and directly UNDERNEATH it the company name in bold letters --',
  'either "HANDY ANDY TV MOUNTING" or "DOM\'S TV MOUNTING". The wordmark is part',
  'of the artwork. It is usually shown full-screen on an otherwise dark TV.',
  '',
  'Say YES only if you can see BOTH the paint-splash swirl AND the company',
  'wordmark beneath it, on a television screen. The logo is often small in the',
  'frame because the photo shows the whole room -- judge by the artwork, not its',
  'size. If you cannot make out the wordmark, say NO.',
  '',
  'Say NO for everything else. In particular these are NOT our logo, even though',
  'they are colourful things on a screen -- they are the most common mistakes:',
  '- a TV brand or operating-system startup / setup screen: the Google TV boot',
  '  animation (four coloured dots or circles), Samsung, LG, Roku, Amazon or',
  '  Vizio setup, a QR code, a sign-in page, a Wi-Fi or language picker',
  '- a streaming service logo or app tile (Netflix, YouTube, Disney, Hulu)',
  '- ordinary TV content: a movie, a show, sport, a music video, a channel logo',
  '- art / gallery / screensaver mode, or a photo displayed on the screen',
  '- a colourful reflection, glare or pattern bouncing off a dark or off screen',
  '- "No Signal", a blue HDMI screen, a black screen, or the TV switched off',
  '- our logo on a van, shirt, sign, business card or paperwork -- it must be',
  '  ON A SCREEN',
  '- a different company\'s logo (the customer\'s own decor, a brand on the wall)',
  '',
  'When in doubt, say NO. A missed logo shot costs nothing; a wrong one puts',
  'junk in a folder the office posts from.',
  '',
  'Reply with exactly one line in this format and nothing else:',
  'YES | <five words on what is on the screen>',
  'or',
  'NO | <five words on why not>',
].join('\n');

async function askClaude(url, signal) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 40,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
    signal,
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const data = await r.json();
  return ((data.content && data.content[0] && data.content[0].text) || '').trim();
}

// One photo → a verdict, or null meaning "couldn't tell, leave it unscanned".
async function scanOne(db, photo) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let text;
  try {
    text = await askClaude(photo.url, ctrl.signal);
  } catch (e) {
    console.error('[photo_logo_scan] photo', photo.id, 'failed:', e.message);
    return null;
  } finally {
    clearTimeout(t);
  }

  // Anything that isn't a clean YES/NO is treated as unreadable rather than as
  // a NO — a mangled reply must not permanently mark a good photo as ordinary.
  const m = /^\s*(YES|NO)\b\s*\|?\s*(.*)$/i.exec(text);
  if (!m) {
    console.error('[photo_logo_scan] photo', photo.id, 'unparseable reply:', JSON.stringify(text).slice(0, 120));
    return null;
  }
  const hit = m[1].toUpperCase() === 'YES';
  const note = (m[2] || '').trim().slice(0, 120) || null;

  const { error } = await db.from('booking_photos')
    .update({ logo_shot: hit, logo_scanned_at: new Date().toISOString(), logo_note: note })
    .eq('id', photo.id);
  if (error) { console.error('[photo_logo_scan] photo', photo.id, 'update failed:', error.message); return null; }
  return { id: photo.id, logo_shot: hit, note };
}

// Pulls the oldest unscanned photos and works through them CONCURRENCY at a
// time. Oldest-first so a backfill drains predictably and a stuck photo can't
// starve the queue behind it (a failure leaves it unscanned, so it is retried
// on the next run — acceptable, since the same photo failing forever is a
// broken URL, which the office would want to know about anyway).
export async function scanLogoPhotos({ limit, dryRun } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: 'ANTHROPIC_API_KEY not set', scanned: 0, hits: 0 };

  const db = serviceClient();

  const n = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { data, error } = await db.from('booking_photos')
    .select('id, url, created_at')
    .is('logo_scanned_at', null)
    .order('created_at', { ascending: true })
    .limit(n);
  if (error) throw error;

  const queue = data || [];
  const { count: remaining } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).is('logo_scanned_at', null);

  if (dryRun) return { dry_run: true, would_scan: queue.length, unscanned_total: remaining ?? null };
  if (!queue.length) return { scanned: 0, hits: 0, unscanned_total: 0 };

  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (cursor < queue.length) {
      const photo = queue[cursor++];
      const r = await scanOne(db, photo);
      if (r) results.push(r);
    }
  }));

  const hits = results.filter(r => r.logo_shot).length;
  console.log('[photo_logo_scan]', `scanned ${results.length}/${queue.length}, ${hits} logo shots,`,
    `${Math.max((remaining ?? queue.length) - results.length, 0)} still unscanned`);
  return {
    scanned: results.length,
    failed: queue.length - results.length,
    hits,
    unscanned_total: Math.max((remaining ?? queue.length) - results.length, 0),
  };
}
