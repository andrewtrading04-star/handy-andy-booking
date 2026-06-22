// /api/calendar.js
// Generates a downloadable .ics file for a booking so customers can add their
// appointment to Apple Calendar (and any other .ics-aware app) straight from the
// confirmation email. Google Calendar uses its own render URL built in the email,
// so this endpoint is primarily the "Add to Apple Calendar" target. Public + GET.
//
//   GET /api/calendar?title=...&start=<epochSec>&end=<epochSec>&location=...&details=...
//
// Returns text/calendar with an attachment disposition so a tap on iOS/macOS
// opens the native "Add to Calendar" sheet.

// RFC 5545 text escaping: backslash, comma, semicolon, and newlines.
function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Epoch seconds -> UTC stamp "YYYYMMDDTHHMMSSZ".
function icsStamp(sec) {
  const d = new Date(Number(sec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// Fold long lines to 75 octets per RFC 5545 (continuation lines start with a space).
function foldLine(line) {
  if (line.length <= 73) return line;
  const out = [];
  let s = line;
  out.push(s.slice(0, 73));
  s = s.slice(73);
  while (s.length > 72) { out.push(' ' + s.slice(0, 72)); s = s.slice(72); }
  if (s.length) out.push(' ' + s);
  return out.join('\r\n');
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { title, start, end, location, details } = req.query || {};
  const startSec = Number(start), endSec = Number(end);
  if (!startSec || !endSec) return res.status(400).json({ error: 'start and end (epoch seconds) are required' });

  const uid = `booking-${startSec}-${Math.random().toString(36).slice(2, 10)}@handyandy`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Handy Andy//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsStamp(startSec)}`,
    `DTEND:${icsStamp(endSec)}`,
    `SUMMARY:${icsEscape(title || 'Appointment')}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    details ? `DESCRIPTION:${icsEscape(details)}` : null,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    'DESCRIPTION:Appointment reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).map(foldLine);

  const ics = lines.join('\r\n');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(ics);
}
