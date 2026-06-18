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
  if (!/^image\//.test(mime)) { const e = new Error('Only image uploads are allowed.'); e.status = 400; throw e; }
  const buffer = Buffer.from(b64, 'base64');
  if (!buffer.length) { const e = new Error('Image data is empty.'); e.status = 400; throw e; }
  // Hard cap so a single request can't blow the function body limit (~4MB raw).
  if (buffer.length > 8 * 1024 * 1024) { const e = new Error('Image is too large. Please retake at lower quality.'); e.status = 413; throw e; }
  return { mime, buffer };
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
