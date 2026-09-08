// Bot / non-customer traffic detection for the analytics pipeline.
//
// Why this exists: precisiontvinstallation.com and tvmountingdenver.com each
// showed ~100 "visitors" reaching the booking page over 30 days and produced
// zero bookings. That looked like a broken funnel. It wasn't — 4.5% and 5.0%
// of those sessions ever typed a ZIP, against 71-75% on the sites with real
// customers, and 0 of 210 sessions resolved to a city (real traffic resolves
// ~33%). They were SEO crawlers, uptime checkers and our own dev browsing.
//
// One shared rule, used at BOTH ends on purpose:
//   - api/log-event.js drops these before insert, so the table stays clean
//   - the analytics readers apply it again to data logged before this existed
// If the two ever disagreed, the dashboard would contradict itself.
//
// Deliberately conservative. A miscounted bot inflates a number; a wrongly
// filtered customer hides a real person, which is the worse failure. Anything
// ambiguous (an empty user agent, an odd mobile browser) is treated as human.

// Self-identifying crawlers, SEO tools, monitors, link unfurlers, and the
// scripted HTTP clients that show up in this table. Kept as one case-insensitive
// alternation so the same string is testable from SQL as well.
// NB "moz\.com" not "moz" — every real browser UA starts with "Mozilla".
// "preview" is deliberately absent: too generic, it would catch browser preview
// channels. The specific link-unfurlers are named individually instead.
const BOT_UA = /(bot\b|bot\/|robot|crawl|spider|slurp|ahrefs|semrush|majestic|moz\.com|dotbot|dataprovider|screaming ?frog|sitecheck|siteaudit|uptime|pingdom|gtmetrix|lighthouse|pagespeed|ptst\/|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|curl\/|wget\/|libwww|okhttp|java\/|go-http|node-fetch|axios\/|got\/|scrapy|facebookexternalhit|externalhit|externalagent|webindexer|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|embedly|feedfetcher|apis-google|mediapartners|adsbot|google-agent|google-inspectiontool|googleother|google-read-aloud|petalbot|bytespider|amazonbot|applebot|yandex|baiduspider|duckduckbot|sogou)/i;

// Our own tooling. The Claude desktop app browses these sites while they are
// being built, which is real HTTP traffic and genuinely not a customer —
// 14 of those 210 sessions were exactly this.
// ClaudeSEO/ is an SEO crawler and distinct from Claude/ (the desktop app),
// so both spellings are listed rather than relying on a shared prefix.
const INTERNAL_UA = /(Claude\/|ClaudeSEO|Electron\/|vercel-screenshot|vercel-favicon)/i;

/**
 * True when a user agent is a crawler, monitor, automation tool, or our own
 * tooling rather than a potential customer.
 * @param {string|null|undefined} ua raw User-Agent header
 */
export function isBotUserAgent(ua) {
  if (!ua) return false; // absent UA stays human: see the conservatism note above
  const s = String(ua);
  return BOT_UA.test(s) || INTERNAL_UA.test(s);
}

// ── Internal / test bookings ────────────────────────────────────────────────
// A user agent can't catch these: the owner books from an ordinary browser, so
// a test booking is byte-for-byte indistinguishable from a customer's until you
// look at who it is. Found 2026-09-08: all 8 "bookings" across milehightv-
// mounting.com, austinmounting.com, houstonmounting.com, houstontvinstallation
// .com and htvmounting.com were the owner testing each new site's funnel --
// same name, email, phone and street address on every one, all cancelled
// immediately. Left uncorrected, five sites looked like they were converting.
//
// Add contacts without a deploy via INTERNAL_TEST_CONTACTS (comma-separated
// emails and/or phone numbers); the default below is the owner's own.
const DEFAULT_INTERNAL_CONTACTS = ['andrewtrading04@gmail.com', '3374997817'];

/** Digits only, so +1 (337) 499-7817 and 3374997817 compare equal. */
function normPhone(v) { return String(v || '').replace(/\D/g, ''); }

function internalContactSet() {
  const extra = (process.env.INTERNAL_TEST_CONTACTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const out = new Set();
  for (const raw of [...DEFAULT_INTERNAL_CONTACTS, ...extra]) {
    const v = String(raw).toLowerCase();
    out.add(v);
    const digits = normPhone(v);
    // 10-digit US numbers also match their +1-prefixed form.
    if (digits.length >= 10) { out.add(digits); out.add(digits.slice(-10)); }
  }
  return out;
}

/**
 * True when a booking's contact details belong to the owner/testers rather than
 * a paying customer. Matches on email or phone; either alone is enough.
 * @param {{email?:string, phone?:string}|null|undefined} contact
 */
export function isInternalContact(contact) {
  if (!contact) return false;
  const set = internalContactSet();
  const email = String(contact.email || '').trim().toLowerCase();
  if (email && set.has(email)) return true;
  const digits = normPhone(contact.phone);
  if (digits && (set.has(digits) || set.has(digits.slice(-10)))) return true;
  return false;
}

// Same rule as a Postgres-flavoured regex, for filtering rows already logged
// before write-time dropping existed. Must stay in step with the two above.
export const BOT_UA_SQL = '(bot\\M|bot/|robot|crawl|spider|slurp|ahrefs|semrush|majestic|moz\\.com|dotbot|dataprovider|screaming ?frog|sitecheck|siteaudit|uptime|pingdom|gtmetrix|lighthouse|pagespeed|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|curl/|wget/|libwww|okhttp|java/|go-http|node-fetch|axios/|got/|scrapy|facebookexternalhit|externalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|embedly|preview|feedfetcher|apis-google|mediapartners|adsbot|google-agent|petalbot|bytespider|amazonbot|applebot|yandex|baiduspider|duckduckbot|sogou|Claude/|Electron/|vercel-screenshot|vercel-favicon)';
