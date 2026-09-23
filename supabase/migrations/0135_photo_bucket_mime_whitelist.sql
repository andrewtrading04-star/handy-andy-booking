-- Photo buckets: raster images only.
--
-- decodeDataUrl (api/_lib/storage.js) used to accept anything matching
-- "image/", which includes image/svg+xml -- and an SVG is a script-bearing
-- document. Served back from our own origin (the note_photo proxies in
-- api/admin.js and api/tech.js echoed the stored Content-Type) it could read
-- localStorage, i.e. the CRM and technician login tokens. Nothing malicious
-- was ever uploaded (checked 2026-09-23, every stored object is a jpeg), but
-- the storage layer should refuse it outright rather than rely on the
-- application check alone.
set search_path = app, public, extensions;

update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
 where id in ('note-photos', 'booking-photos');
