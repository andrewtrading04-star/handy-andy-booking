// api/_lib/notes.js
// Shared by the owner -> secretary notes (api/admin.js) and the owner ->
// technician notes (api/admin.js writes them, api/tech.js shows them), so the
// two can never disagree about what "today" or "still showing" means.
import { localDateTimeUTC } from './time.js';

// "Today" is Denver's date, not the server's — a note written at 11pm Bangkok
// belongs to the Denver day the office is actually working.
export function denverToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
}

// A note is live if it has been sent (send_at, when scheduled, is not in the
// future) and its window still covers today. 'until_read' has no end — that is
// the point of it: it stays until somebody actually acknowledges it.
export function noteIsLive(n, today) {
  if (n.send_at && new Date(n.send_at).getTime() > Date.now()) return false;
  if (n.show_from > today) return false;
  if (n.mode === 'until_read') return true;
  const span = n.mode === 'two_days' ? 1 : 0;
  const end = new Date(n.show_from + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + span);
  return today <= end.toISOString().slice(0, 10);
}

// Scheduled but not yet sent.
export function noteIsScheduled(n) {
  return !!(n.send_at && new Date(n.send_at).getTime() > Date.now());
}

// The owner picks a send date + time in DENVER time (the office's clock, not
// the browser's — he is usually in Bangkok). No date = send now. Returns
// { send_at, show_from } to spread into the insert, or { error } for a 400.
const SEND_MAX_DAYS_AHEAD = 90;
export function resolveSendAt(body) {
  const date = String((body && body.send_date) || '').trim();
  const time = String((body && body.send_time) || '').trim();
  if (!date && !time) return { send_at: null, show_from: denverToday() };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { error: 'Pick both a date and a time to schedule it' };
  }
  const at = localDateTimeUTC('America/Denver', date, time);
  if (Number.isNaN(at.getTime())) return { error: 'That date and time is not valid' };
  const now = Date.now();
  if (at.getTime() <= now) return { error: 'That time has already passed. Pick a time in the future, or choose Send now.' };
  if (at.getTime() > now + SEND_MAX_DAYS_AHEAD * 86400000) return { error: `Schedule within the next ${SEND_MAX_DAYS_AHEAD} days` };
  return { send_at: at.toISOString(), show_from: date };
}

// Photos on a note are uploaded first (admin.js notes_photo) and the note then
// carries their URLs. Only URLs inside THIS project's note-photos folder are
// accepted, so a note can't be made to embed an arbitrary outside image.
export const NOTE_PHOTO_PREFIX = 'note-photos';
export const NOTE_MAX_PHOTOS = 4;
// Private-bucket photos (storage.js uploadPrivateImage, the only kind uploaded
// since 2026-09-23) arrive as "priv:note-photos/<uuid>.<ext>". This filter
// used to accept ONLY the old public URL shape, so it silently dropped every
// private photo and notes saved with photo_urls [] -- Jiyah's four
// "Website Inspiration" notes lost all 14 of their photos that way.
const PRIVATE_NOTE_PHOTO_RE = new RegExp(`^priv:${NOTE_PHOTO_PREFIX}/[0-9a-f-]{36}\\.(jpg|png|webp|heic)$`);
export function isPrivateNotePhoto(u) { return PRIVATE_NOTE_PHOTO_RE.test(String(u || '')); }
export function cleanNotePhotos(input) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!Array.isArray(input)) return [];
  const allowed = base ? `${base}/storage/v1/object/public/booking-photos/${NOTE_PHOTO_PREFIX}/` : null;
  return [...new Set(input.map(u => String(u || '').trim())
    .filter(u => u.length < 400 && (isPrivateNotePhoto(u) || (allowed && u.startsWith(allowed)))))]
    .slice(0, NOTE_MAX_PHOTOS);
}
