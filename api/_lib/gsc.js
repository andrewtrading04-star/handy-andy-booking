// ============================================================================
// api/_lib/gsc.js — Google Search Console Search Analytics (free keyword data)
// ----------------------------------------------------------------------------
// Pulls "what did people type into Google to find us" for a domain, using a
// service account with read-only ("Restricted") access added directly in
// Search Console — no OAuth login flow, no paid API, just a stored JSON key
// (GSC_SERVICE_ACCOUNT_JSON env var).
//
// No googleapis dependency: a service-account JWT is just a signed token, and
// Node's built-in crypto module can RS256-sign it directly (same pattern this
// codebase already uses elsewhere — minimal dependencies, plain fetch calls).
// ============================================================================

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function credentials() {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Cached in module scope so a warm serverless instance reuses the token for
// its ~1hr lifetime instead of re-signing + re-requesting on every call.
let _tokenCache = null;
async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 30000) return _tokenCache.token;
  const creds = credentials();
  if (!creds || !creds.client_email || !creds.private_key) {
    throw new Error('GSC_SERVICE_ACCOUNT_JSON is missing or invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    base64url(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const crypto = await import('node:crypto');
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!r.ok) throw new Error(`GSC token request failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const data = await r.json();
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return _tokenCache.token;
}

// A domain can be verified in Search Console as a Domain property
// (sc-domain:example.com, covers every protocol/subdomain) or a URL-prefix
// property (https://example.com/, optionally with www) — we don't ask the
// caller to know which, we just try the common shapes.
const _siteCache = new Map();
function siteCandidates(domain) {
  return [`sc-domain:${domain}`, `https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`];
}

// Search Analytics query for a domain over [startDate, endDate] ('YYYY-MM-DD').
// `dimensions` controls the grouping — ['query'] for plain top-queries,
// ['query','page'] to pair each query with its landing page, etc. Each row's
// `keys` array lines up positionally with the requested dimensions.
// Best-effort: throws with a clear message on total failure so callers can
// degrade gracefully (this is a bonus data source, not core functionality).
export async function gscQuery({ domain, startDate, endDate, dimensions = ['query'], rowLimit = 25 }) {
  const token = await getAccessToken();
  const known = _siteCache.get(domain);
  const candidates = known ? [known, ...siteCandidates(domain).filter(s => s !== known)] : siteCandidates(domain);
  let lastErr = null;
  for (const site of candidates) {
    try {
      const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, type: 'web' }),
      });
      if (!r.ok) { lastErr = new Error(`${site}: HTTP ${r.status} — ${(await r.text().catch(() => '')).slice(0, 200)}`); continue; }
      const data = await r.json();
      _siteCache.set(domain, site);
      return {
        site,
        rows: (data.rows || []).map(row => ({
          keys: row.keys || [],
          clicks: row.clicks || 0,
          impressions: row.impressions || 0,
          ctr: row.ctr || 0,
          position: row.position || 0,
        })),
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`No matching Search Console property found for ${domain}`);
}
