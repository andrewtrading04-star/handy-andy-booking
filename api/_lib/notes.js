// api/_lib/notes.js
// Shared by the owner -> secretary notes (api/admin.js) and the owner ->
// technician notes (api/admin.js writes them, api/tech.js shows them), so the
// two can never disagree about what "today" or "still showing" means.

// "Today" is Denver's date, not the server's — a note written at 11pm Bangkok
// belongs to the Denver day the office is actually working.
export function denverToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
}

// A note is live if its window still covers today. 'until_read' has no end —
// that is the point of it: it stays until somebody actually acknowledges it.
export function noteIsLive(n, today) {
  if (n.show_from > today) return false;
  if (n.mode === 'until_read') return true;
  const span = n.mode === 'two_days' ? 1 : 0;
  const end = new Date(n.show_from + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + span);
  return today <= end.toISOString().slice(0, 10);
}

// Photos on a note are uploaded first (admin.js notes_photo) and the note then
// carries their URLs. Only URLs inside THIS project's note-photos folder are
// accepted, so a note can't be made to embed an arbitrary outside image.
export const NOTE_PHOTO_PREFIX = 'note-photos';
export const NOTE_MAX_PHOTOS = 4;
export function cleanNotePhotos(input) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base || !Array.isArray(input)) return [];
  const allowed = `${base}/storage/v1/object/public/booking-photos/${NOTE_PHOTO_PREFIX}/`;
  return [...new Set(input.map(u => String(u || '').trim()).filter(u => u.startsWith(allowed) && u.length < 400))]
    .slice(0, NOTE_MAX_PHOTOS);
}
