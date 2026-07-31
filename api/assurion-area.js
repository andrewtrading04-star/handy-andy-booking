// /api/assurion-area.js
// ZIP-code service-area check for the Asurion/Techs To You widget.
// DISABLED 2026-07-31 — this endpoint was entirely Zenbooker-backed (no
// native equivalent was ever built) and Zenbooker was canceled that day.
// Zero bookings with source='asurion' exist in the database, ever, so this
// channel had no real traffic to migrate. If the Assurion/Steve channel is
// still wanted, it needs a native rebuild (zip check via service_area_zips,
// slots via publicOpenSlots, booking via mirrorBooking) — not a patch here.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ error: 'This booking channel is no longer available.' });
}
