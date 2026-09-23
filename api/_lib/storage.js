// Minimal Supabase Storage helper for job photos. Uploads/deletes objects in
// the public `booking-photos` bucket using the SERVICE ROLE key (server-side
// only) via Storage's REST API — no extra SDK surface needed.
//
// Photos come from the browser as a data URL (e.g. "data:image/jpeg;base64,...")
// already resized/compressed client-side, so payloads stay small.
import crypto from 'crypto';

const BUCKET = 'booking-photos';

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { const e = new Error('Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).'); e.status = 500; throw e; }
  return { url: url.replace(/\/$/, ''), key };
}

// Parse a data URL (or bare base64) into { mime, buffer }. Throws on non-images.
function decodeDataUrl(input) {
  if (!input || typeof input !== 'string') { const e = new Error('No image data provided.'); e.status = 400; throw e; }
  let mime = 'image/jpeg';
  let b64 = input;
  const m = input.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { mime = m[1]; b64 = m[2]; }
  // A whitelist, not a bare "image/" prefix test: image/svg+xml passes that
  // test, but an SVG is a SCRIPT-BEARING document. Served back from our own
  // origin it can read localStorage -- i.e. the CRM and tech login tokens --
  // so only the raster formats our own compressImage() actually produces are
  // accepted. The proxies that serve these files back also pin Content-Type
  // from the file extension rather than trusting whatever was stored.
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) {
    const e = new Error('Only JPEG, PNG, WebP, or HEIC photos are allowed.'); e.status = 400; throw e;
  }
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) { const e = new Error('Image data is empty.'); e.status = 400; throw e; }
  // Hard cap so a single request can't blow the function body limit (~4MB raw).
  if (buffer.length > 8 * 1024 * 1024) { const e = new Error('Image is too large. Please retake at lower quality.'); e.status = 413; throw e; }
  return { mime, buffer };
}

// What a private note photo is served AS. Keyed off the stored file's
// extension (which uploadPrivateImage picked via extFor, and which the
// isPrivateNotePhoto regex restricts), never off the Content-Type Supabase
// hands back -- a proxy that echoes a stored type lets whoever uploaded the
// file choose how our own origin serves it.
export const NOTE_PHOTO_CONTENT_TYPES = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
};
export function notePhotoContentType(pathOrUrl) {
  const ext = String(pathOrUrl || '').split('.').pop().toLowerCase();
  return NOTE_PHOTO_CONTENT_TYPES[ext] || 'application/octet-stream';
}

function extFor(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  return 'jpg';
}

// Upload an image under `${prefix}/<uuid>.<ext>`. Returns { path, url }.
export async function uploadImage(dataUrl, prefix) {
  const { url, key } = cfg();
  const { mime, buffer } = decodeDataUrl(dataUrl);
  const path = `${prefix}/${crypto.randomUUID()}.${extFor(mime)}`;
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': mime, 'x-upsert': 'true', 'cache-control': '3600' },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(`Photo upload failed (${res.status}). ${t.slice(0, 200)}`); e.status = 502; throw e;
  }
  return { path, url: `${url}/storage/v1/object/public/${BUCKET}/${encodeURI(path)}` };
}

// Best-effort delete of a stored object (ignores "not found").
export async function deleteImage(path) {
  if (!path) return;
  const { url, key } = cfg();
  try {
    await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${key}` },
    });
  } catch { /* non-fatal: the DB row is the source of truth */ }
}

// ── Private bucket (note photos) ────────────────────────────────────────────
// Owner rule 2026-09-23: "i need to be able to view them securely" -- unlike
// booking-photos (public bucket, plain URLs), note-photos is a PRIVATE
// bucket (migration 0134). uploadPrivateImage returns only a `path` -- no
// browsable URL exists for it at all -- and readPrivateImage fetches the
// bytes server-side with the service role key, for the note_photo proxy
// action (api/admin.js) to stream back to an authenticated CRM session only.
const PRIVATE_BUCKET = 'note-photos';
export async function uploadPrivateImage(dataUrl, prefix) {
  const { url, key } = cfg();
  const { mime, buffer } = decodeDataUrl(dataUrl);
  const path = `${prefix}/${crypto.randomUUID()}.${extFor(mime)}`;
  const res = await fetch(`${url}/storage/v1/object/${PRIVATE_BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': mime, 'x-upsert': 'true', 'cache-control': '3600' },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(`Photo upload failed (${res.status}). ${t.slice(0, 200)}`); e.status = 502; throw e;
  }
  // "priv:" prefix marks this as a private-bucket path so the reader (any
  // photo_urls consumer) can tell it apart from an old public-bucket URL
  // without a schema change or a lookup.
  return { path: `priv:${path}` };
}

// Fetches a private-bucket object's raw bytes + content-type, for proxying.
// Throws 404-shaped errors the caller can turn into a real 404.
export async function readPrivateImage(path) {
  const { url, key } = cfg();
  const res = await fetch(`${url}/storage/v1/object/${PRIVATE_BUCKET}/${encodeURI(path)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) { const e = new Error('Photo not found.'); e.status = 404; throw e; }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export async function deletePrivateImage(path) {
  if (!path) return;
  const { url, key } = cfg();
  try {
    await fetch(`${url}/storage/v1/object/${PRIVATE_BUCKET}/${encodeURI(path)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${key}` },
    });
  } catch { /* non-fatal */ }
}
