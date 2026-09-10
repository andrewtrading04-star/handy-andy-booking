// Per-sender speed limit for the public lead forms (api/quote.js,
// api/doms-lead.js).
//
// Why this exists: on 2026-09-04 and 2026-09-07 a bot drove the real
// ihandyandy.com quote form in a headless browser and fired 13 fake "New quote
// request"s in bursts -- 6 in 12 seconds, then 1, 1, and 5 in 14 seconds --
// every one of them texting Heather. All 13 used the same Gmail inbox with dots
// sprinkled through the name (nijujid.a.q.i.z.0.1@gmail.com), which Gmail
// treats as one address. A real customer sends one request, maybe a second if
// they think the first didn't go through. So once the same connection, the same
// inbox or the same phone number has sent a few in ten minutes, the rest are
// dropped. (Phone matters for doms-lead, where email is optional -- without it
// a request would only be counted by IP.)
//
// Kept in memory on purpose: no table, nothing to migrate. A burst like the
// ones above lands on a warm function instance, which is exactly when this
// catches it; a cold start forgets and lets a few more through, and each
// endpoint's own honeypot/origin/timing checks still apply to those. It never
// blocks anyone's first submission.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 3;
const hits = new Map(); // key -> timestamps (ms) inside the window

/** Gmail ignores dots and anything after "+", so collapse those to one inbox. */
export function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** The visitor's IP as Vercel reports it (first hop of x-forwarded-for). */
export function clientIp(req) {
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xff || String((req.headers && req.headers['x-real-ip']) || '');
}

function recordAndCount(key, now) {
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length;
}

/**
 * Records one submission and returns true when its sender is past the limit --
 * more than MAX_PER_WINDOW in WINDOW_MS from the same IP, the same
 * (normalized) email OR the same phone number. `scope` keeps each form's
 * counts separate.
 * @param {string} scope e.g. 'quote' or 'doms-lead'
 * @param {{ip?: string, email?: string, phone?: string}} sender
 */
export function overSpeedLimit(scope, { ip, email, phone } = {}) {
  const now = Date.now();
  // A long-lived instance must not grow this map forever.
  if (hits.size > 5000) {
    for (const [k, ts] of hits) if (!ts.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  let over = false;
  if (ip && recordAndCount(`${scope}|ip|${ip}`, now) > MAX_PER_WINDOW) over = true;
  const em = normalizeEmail(email);
  if (em.includes('@') && recordAndCount(`${scope}|em|${em}`, now) > MAX_PER_WINDOW) over = true;
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length >= 7 && recordAndCount(`${scope}|ph|${digits}`, now) > MAX_PER_WINDOW) over = true;
  return over;
}
