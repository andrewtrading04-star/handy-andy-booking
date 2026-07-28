// ============================================================================
// Grasshopper voicemail email parser
// ----------------------------------------------------------------------------
// Grasshopper (the office phone system) has NO public API, no webhooks and no
// Zapier integration — verified Jul 2026. The ONLY machine-readable signal it
// emits is the notification email it sends to the owner's inbox, so that email
// is the integration surface. A Google Apps Script on the owner's own account
// forwards each one here (see docs/grasshopper-gmail-script.md).
//
// A real message body looks like this:
//
//   New Grasshopper Voicemail
//
//   Caller: (321) 419-3604
//   Extension: 1 - TV Mounting
//   Grasshopper #: (720) 637-3707
//   Timestamp: 7/28/2026 1:36:00 PM Central Daylight Time
//
//   Read Your Voicemail
//   "Hi, this is Eileen Helms ..."
//
//   Play this voicemail on your mobile phone or online
//
// Pure module: no DB, no network. Run `GRASSHOPPER_SELFTEST=1 node
// api/_lib/grasshopper.js` for the built-in tests.
// ============================================================================

// ── Which phone line was dialed -> which market ─────────────────────────────
// Grasshopper stamps EVERY email in Central time regardless of the market the
// number belongs to, so the line dialed is the only reliable market signal in
// the message (the timestamp's zone tells you nothing about where the caller
// was calling). Keyed by the 10 digits of the Grasshopper number.
//
// An unrecognized number is NOT an error — the call is still recorded, just
// without a market, and the dashboard shows it as unrouted so a human can add
// the number here. Never drop a real customer's voicemail over a config gap.
export const GRASSHOPPER_LINES = {
  '7206373707': { market: 'Denver',  business: 'handy-andy' },
  '7205418180': { market: 'Denver',  business: 'handy-andy' },
  '2816388419': { market: 'Houston', business: 'handy-andy' },
  '7138769032': { market: 'Houston', business: 'handy-andy' },
  '5126686643': { market: 'Austin',  business: 'handy-andy' },
};
// Fallback when the exact line isn't mapped above: infer the market from the
// number's area code. Cheaper to maintain than the map (a new Denver number
// still routes correctly on day one) but less precise, so the map wins.
const AREA_CODE_MARKET = {
  '303': 'Denver', '720': 'Denver', '970': 'Denver',
  '281': 'Houston', '713': 'Houston', '832': 'Houston', '346': 'Houston',
  '512': 'Austin', '737': 'Austin',
};

// Windows/legacy timezone NAMES as Grasshopper writes them, mapped to IANA
// zones. Only used for the FALLBACK timestamp path — see occurredAt below.
const TZ_NAMES = {
  'eastern':  'America/New_York',
  'central':  'America/Chicago',
  'mountain': 'America/Denver',
  'pacific':  'America/Los_Angeles',
  'alaskan':  'America/Anchorage',
  'hawaiian': 'Pacific/Honolulu',
};

// ── Helpers ─────────────────────────────────────────────────────────────────
export function digitsOf(s) {
  const d = String(s || '').replace(/\D/g, '');
  // Strip a leading US country code so "+1 (720) 637-3707" and "7206373707"
  // are the same key everywhere (map lookups, customer matching, dedupe).
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
export function prettyPhone(s) {
  const d = digitsOf(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || '').trim();
}

// True offset (ms) of `timeZone` at a given instant, via Intl — no dependency
// and DST-correct, unlike a hardcoded offset table.
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}
// Convert a WALL-CLOCK reading in `timeZone` into a real instant. Resolved
// twice so a reading that lands near a DST switch uses the offset actually in
// force at the resulting instant, not the one at the naive guess.
function wallClockToInstant({ y, mo, d, h, mi, s }, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let ms = guess - off1;
  const off2 = tzOffsetMs(new Date(ms), timeZone);
  if (off2 !== off1) ms = guess - off2;
  return new Date(ms);
}

// Parse Grasshopper's "7/28/2026 1:36:00 PM Central Daylight Time" field.
// Returns a Date, or null if the shape isn't recognized.
export function parseGrasshopperTimestamp(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s*(.*)$/i);
  if (!m) return null;
  const [, mo, d, y, hh, mi, ss, ampm, zoneText] = m;
  let h = parseInt(hh, 10);
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  const zoneKey = Object.keys(TZ_NAMES).find(k => new RegExp(`\\b${k}`, 'i').test(zoneText || ''));
  const tz = TZ_NAMES[zoneKey] || 'America/Chicago';   // Grasshopper's own default
  const dt = wallClockToInstant(
    { y: +y, mo: +mo, d: +d, h, mi: +mi, s: ss ? +ss : 0 }, tz);
  return isNaN(dt.getTime()) ? null : dt;
}

// Grasshopper's transcription drops the space after punctuation ("...419-3604.I
// have a smallish...", "43 inches by 27,HiSense Roku"), which makes the text
// painful to skim in a hurry — exactly when a secretary is reading it. Re-space
// it conservatively: only where the punctuation is followed by a CAPITAL
// letter, which is what keeps decimals ("43.5") and thousands separators
// ("1,000") intact, since those are followed by digits.
//
// Note the character class includes digits: the real-world break is usually
// right after a spoken phone number, where the char before the period is "4".
//
// Words that ran together with no punctuation at all ("the walland left") are
// left alone — there is no safe rule for splitting those, and guessing would
// corrupt the only record of what the customer said.
export function tidyTranscript(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/([a-z0-9,])\.([A-Z])/g, '$1. $2')
    .replace(/([a-z0-9])\?([A-Z])/g, '$1? $2')
    .replace(/([a-z0-9])!([A-Z])/g, '$1! $2')
    .replace(/([a-z0-9]),([A-Z])/g, '$1, $2')
    .trim();
}

function field(body, label) {
  // Tolerant of the label appearing mid-line, since forwarded/HTML-stripped
  // copies collapse the layout. Stops at the next known label or end of line.
  const re = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\s*(?:Caller|Extension|Grasshopper\\s*#|Timestamp)\\s*:|[\\r\\n]|$)`, 'i');
  const m = String(body || '').match(re);
  return m ? m[1].trim() : null;
}

// ── Main entry ──────────────────────────────────────────────────────────────
// Input:  { subject, body, receivedAt, messageId }
//   receivedAt — the email's own Date header, as an ISO string or Date. This is
//   the AUTHORITATIVE time: it is a real instant with a real offset, whereas
//   the body's Timestamp line is a wall-clock reading whose zone has to be
//   parsed out of English prose. The body timestamp is only a fallback.
// Output: { ok, kind, caller_phone, grasshopper_number, extension, extension_no,
//           service, market, business_slug, occurred_at, transcript,
//           has_recording, warnings[] } or { ok:false, error }
export function parseGrasshopperEmail({ subject = '', body = '', receivedAt = null, messageId = null, hasAttachment = false } = {}) {
  const text = String(body || '');
  const warnings = [];

  // Only voicemail notifications exist today (confirmed against the owner's
  // full Grasshopper inbox, Jul 2026 — every message is "Voicemail from ...").
  // `kind` is stored anyway so missed-call emails can be added later without a
  // schema change or a rewrite of anything downstream.
  const isVoicemail = /voicemail/i.test(subject) || /New Grasshopper Voicemail/i.test(text);
  const isMissed = /missed call/i.test(subject) || /missed call/i.test(text);
  if (!isVoicemail && !isMissed) return { ok: false, error: 'Not a Grasshopper call notification' };
  const kind = isVoicemail ? 'voicemail' : 'missed';

  // Caller: prefer the body field, fall back to the subject ("Voicemail from
  // (321) 419-3604") so a message whose body failed to render still lands.
  let callerRaw = field(text, 'Caller');
  if (!callerRaw) {
    const sm = String(subject).match(/from\s+(\+?[\d()\-.\s]{7,})/i);
    if (sm) callerRaw = sm[1];
  }
  const caller_phone = digitsOf(callerRaw);
  if (caller_phone.length !== 10) {
    // Without a number the record is useless: it can't be matched, returned, or
    // deduped. Fail loudly rather than storing an anonymous row.
    return { ok: false, error: `Could not read a 10-digit caller number (got "${callerRaw || ''}")` };
  }

  const grasshopper_number = digitsOf(field(text, 'Grasshopper\\s*#'));
  const extension = field(text, 'Extension');                       // "1 - TV Mounting"
  const extMatch = extension && extension.match(/^\s*(\d+)\s*[-–—]?\s*(.*)$/);
  const extension_no = extMatch ? parseInt(extMatch[1], 10) : null;
  const service = extMatch && extMatch[2] ? extMatch[2].trim() : (extension || null);

  const line = GRASSHOPPER_LINES[grasshopper_number] || null;
  const market = line ? line.market : (AREA_CODE_MARKET[grasshopper_number.slice(0, 3)] || null);
  const business_slug = line ? line.business : 'handy-andy';
  if (!market) warnings.push(`Unrecognized Grasshopper line ${prettyPhone(grasshopper_number) || '(none)'} — no market assigned`);

  // Time. receivedAt is authoritative (see above); the body's own Timestamp is
  // the fallback and also a cross-check.
  const bodyTs = parseGrasshopperTimestamp(field(text, 'Timestamp'));
  let occurred = receivedAt ? new Date(receivedAt) : null;
  if (!occurred || isNaN(occurred.getTime())) occurred = bodyTs;
  if (!occurred) return { ok: false, error: 'Could not determine when the call happened' };
  // More than 30 minutes apart means one of the two is wrong — worth a human
  // glance, but never a reason to drop the voicemail.
  if (bodyTs && receivedAt && Math.abs(bodyTs.getTime() - occurred.getTime()) > 30 * 60 * 1000) {
    warnings.push(`Email time and the timestamp inside the message differ by more than 30 minutes`);
  }

  // Transcript: the block between the "Read Your Voicemail" heading and the
  // "Play this voicemail" footer. Quotes around it are Grasshopper's, not part
  // of the message.
  let transcript = null;
  const tm = text.match(/Read Your Voicemail\s*["“]?([\s\S]*?)["”]?\s*(?:Play this voicemail|Sign in to your account|Love Grasshopper|$)/i);
  if (tm && tm[1].trim()) transcript = tidyTranscript(tm[1]);
  if (kind === 'voicemail' && !transcript) warnings.push('No transcript in this message');

  return {
    ok: true,
    kind,
    caller_phone,
    grasshopper_number: grasshopper_number || null,
    extension: extension || null,
    extension_no,
    service,
    market,
    business_slug,
    occurred_at: occurred.toISOString(),
    transcript,
    has_recording: !!hasAttachment,
    message_id: messageId || null,
    warnings,
  };
}

// ── Self-tests ──────────────────────────────────────────────────────────────
// Run ONLY on request: GRASSHOPPER_SELFTEST=1 node api/_lib/grasshopper.js
// Never auto-run on import — this module is imported by the admin API.
function selfTest() {
  let fails = 0;
  const eq = (got, want, label) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { fails++; console.log(`✗ ${label}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
    else console.log(`✓ ${label}`);
  };

  // Andrew's real voicemail, verbatim.
  const REAL = `New Grasshopper Voicemail

Caller: (321) 419-3604
Extension: 1 - TV Mounting
Grasshopper #: (720) 637-3707
Timestamp: 7/28/2026 1:36:00 PM Central Daylight Time


Read Your Voicemail
"Hi, this is Eileen Helms, 321-419-3604.I have a smallish flat screen TV, 43 inches by 27,HiSense Roku that when we moved, we grabbed it off the walland left the mounting bracket behind, and I need a new one here.And I just was trying to get a ballpark estimate figurewhat that would run, because we have no clue.And it would be helpful to have someone else do it instead of one more thing on the list.So thank you."


Play this voicemail on your mobile phone or online
Sign in to your account`;

  const r = parseGrasshopperEmail({
    subject: 'Voicemail from (321) 419-3604', body: REAL,
    receivedAt: '2026-07-28T18:36:00.000Z', messageId: 'abc123', hasAttachment: true,
  });
  eq(r.ok, true, 'real sample parses');
  eq(r.caller_phone, '3214193604', 'caller number');
  eq(r.grasshopper_number, '7206373707', 'grasshopper line');
  eq(r.extension_no, 1, 'extension number');
  eq(r.service, 'TV Mounting', 'service from extension');
  eq(r.market, 'Denver', 'Denver market from the 720 line');
  eq(r.kind, 'voicemail', 'kind');
  eq(r.has_recording, true, 'recording attachment noted');
  eq(r.warnings, [], 'no warnings on a clean message');
  eq(/^Hi, this is Eileen Helms/.test(r.transcript), true, 'transcript captured');
  eq(/3604\. I have/.test(r.transcript), true, 'run-together after a phone number re-spaced');
  eq(/27, HiSense/.test(r.transcript), true, 'run-together after a comma re-spaced');
  eq(/here\. And I just/.test(r.transcript), true, 'run-together after a word re-spaced');
  eq(tidyTranscript('It cost 43.5 inches and 1,000 dollars'), 'It cost 43.5 inches and 1,000 dollars',
     'decimals and thousands separators left alone');
  eq(tidyTranscript('the walland left it'), 'the walland left it', 'merged words are not guessed at');
  eq(/Play this voicemail/.test(r.transcript), false, 'footer excluded from transcript');

  // The body timestamp is 1:36 PM Central = 18:36 UTC — the same instant as the
  // email header above, which is why that sample produced no drift warning.
  eq(parseGrasshopperTimestamp('7/28/2026 1:36:00 PM Central Daylight Time').toISOString(),
     '2026-07-28T18:36:00.000Z', 'Central PM timestamp -> UTC');
  eq(parseGrasshopperTimestamp('1/15/2026 9:05:00 AM Central Standard Time').toISOString(),
     '2026-01-15T15:05:00.000Z', 'Central AM in winter (CST) -> UTC');
  eq(parseGrasshopperTimestamp('7/28/2026 12:30:00 AM Central Daylight Time').toISOString(),
     '2026-07-28T05:30:00.000Z', 'midnight hour is 00, not 12');
  eq(parseGrasshopperTimestamp('7/28/2026 12:30:00 PM Central Daylight Time').toISOString(),
     '2026-07-28T17:30:00.000Z', 'noon hour stays 12');

  // Falls back to the body timestamp when no email date is supplied.
  eq(parseGrasshopperEmail({ subject: 'Voicemail from (321) 419-3604', body: REAL }).occurred_at,
     '2026-07-28T18:36:00.000Z', 'falls back to the in-body timestamp');

  // Markets for the other lines seen in the owner's inbox.
  const lineMarket = (num) => parseGrasshopperEmail({
    subject: 'Voicemail from (901) 212-3541',
    body: `New Grasshopper Voicemail\nCaller: (901) 212-3541\nExtension: 1 - TV Mounting\nGrasshopper #: ${num}\nTimestamp: 7/28/2026 1:36:00 PM Central Daylight Time\n`,
  }).market;
  eq(lineMarket('(281) 638-8419'), 'Houston', 'Houston line');
  eq(lineMarket('(713) 876-9032'), 'Houston', 'second Houston line');
  eq(lineMarket('(512) 668-6643'), 'Austin', 'Austin line');
  eq(lineMarket('(720) 541-8180'), 'Denver', 'second Denver line');
  // An unknown 720 number still routes by area code rather than being dropped.
  eq(lineMarket('(720) 111-2222'), 'Denver', 'unmapped 720 falls back to the area code');

  // Extension 2 is the handyman line.
  const ext2 = parseGrasshopperEmail({
    subject: 'Voicemail from (720) 987-7428',
    body: `New Grasshopper Voicemail\nCaller: (720) 987-7428\nExtension: 2 - Handyman\nGrasshopper #: (720) 541-8180\nTimestamp: 7/28/2026 9:00:00 AM Central Daylight Time\n`,
  });
  eq([ext2.extension_no, ext2.service], [2, 'Handyman'], 'extension 2 = Handyman');

  // A voicemail with no transcript is still recorded, with a warning.
  const noTx = parseGrasshopperEmail({
    subject: 'Voicemail from (303) 921-0786',
    body: `New Grasshopper Voicemail\nCaller: (303) 921-0786\nExtension: 1 - TV Mounting\nGrasshopper #: (720) 637-3707\nTimestamp: 7/28/2026 2:00:00 PM Central Daylight Time\n`,
  });
  eq(noTx.ok, true, 'missing transcript still parses');
  eq(noTx.warnings.length, 1, 'missing transcript warns');

  // Junk and unusable input are rejected rather than stored as empty rows.
  eq(parseGrasshopperEmail({ subject: 'Your invoice', body: 'unrelated' }).ok, false, 'non-Grasshopper email rejected');
  eq(parseGrasshopperEmail({ subject: 'Voicemail from someone', body: 'New Grasshopper Voicemail\nCaller: n/a\n' }).ok,
     false, 'unreadable caller number rejected');

  // Country-code and formatting variations normalize to the same key.
  eq(digitsOf('+1 (720) 637-3707'), '7206373707', '+1 prefix stripped');
  eq(digitsOf('720.637.3707'), '7206373707', 'dotted format');
  eq(prettyPhone('7206373707'), '(720) 637-3707', 'pretty format');

  console.log(fails ? `\n${fails} FAILED` : '\nAll Grasshopper parser tests passed');
  return fails;
}

if (process.env.GRASSHOPPER_SELFTEST === '1') {
  process.exit(selfTest() ? 1 : 0);
}
