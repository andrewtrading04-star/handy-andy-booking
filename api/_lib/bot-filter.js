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

// Same rule as a Postgres-flavoured regex, for filtering rows already logged
// before write-time dropping existed. Must stay in step with the two above.
export const BOT_UA_SQL = '(bot\\M|bot/|robot|crawl|spider|slurp|ahrefs|semrush|majestic|moz\\.com|dotbot|dataprovider|screaming ?frog|sitecheck|siteaudit|uptime|pingdom|gtmetrix|lighthouse|pagespeed|headless|phantomjs|puppeteer|playwright|selenium|webdriver|python-requests|python-urllib|curl/|wget/|libwww|okhttp|java/|go-http|node-fetch|axios/|got/|scrapy|facebookexternalhit|externalhit|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|embedly|preview|feedfetcher|apis-google|mediapartners|adsbot|google-agent|petalbot|bytespider|amazonbot|applebot|yandex|baiduspider|duckduckbot|sogou|Claude/|Electron/|vercel-screenshot|vercel-favicon)';
