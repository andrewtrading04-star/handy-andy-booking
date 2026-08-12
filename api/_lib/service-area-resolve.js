// /api/_lib/service-area-resolve.js
// The ONE place a zip becomes a service area. Extracted from the inline body
// of nativeServiceArea() in /api/service-area.js so that server-side callers
// (admin brokering, reporting) resolve a zip exactly the way the booking
// widget does -- including the Los Angeles special case, which is the whole
// reason this file exists.
//
// LA has ZERO rows in app.service_area_zips (verified Aug 2026: DFW 181,
// Phoenix 136, San Antonio 91, LA 0). A plain postal_code join therefore
// returns null for every single LA address, which would silently exclude the
// entire LA market from anything keyed off `unstaffed`. Any new code that
// needs "which area is this zip in" must call resolveServiceArea() rather
// than re-implementing the join and re-introducing that hole.

// The table stores bare 5-digit zips; callers sometimes send a ZIP+4
// ("80220-1032"), which the exact-match lookup missed. Keep the leading 5.
// STRICT shape: only a bare zip or a real ZIP+4 tail normalizes; a 6-digit
// typo ("800122") must NOT silently become the different-but-real zip 80012.
export function zip5(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{5})(?:[-\s]\d{1,4})?$/);
  return m ? m[1] : s;
}

// Full California range. Deliberately a range rather than thousands of seeded
// service_area_zips rows; if LA is ever really launched, real per-zip rows are
// seeded and they take precedence over this fallback on the line above.
const CA_ZIP_RE = /^9(?:[0-5]\d{3}|6[01]\d{2})$/;

// Resolves a zip to { id, name, state, timezone, unstaffed } for one business,
// or null when the zip is not covered. Pure lookup: no HTTP, no res.
export async function resolveServiceArea(db, businessId, businessSlug, rawZip) {
  const zip = zip5(rawZip);
  if (!zip) return null;

  const { data: z, error } = await db.from('service_area_zips')
    .select('service_area:service_areas ( id, name, state, timezone, unstaffed )')
    .eq('business_id', businessId).eq('postal_code', zip).maybeSingle();
  if (error) throw error;
  if (z && z.service_area) {
    const a = z.service_area;
    return {
      id: a.id, name: a.name, state: a.state,
      timezone: a.timezone || null, unstaffed: !!a.unstaffed,
    };
  }

  // No per-zip row. Only handy-andy has the unstaffed LA area, and only a CA
  // zip may fall back to it.
  if (businessSlug === 'handy-andy' && CA_ZIP_RE.test(zip)) {
    const { data: la } = await db.from('service_areas')
      .select('id, name, state, timezone, unstaffed')
      .eq('business_id', businessId).eq('state', 'CA').eq('active', true).maybeSingle();
    if (la) {
      return {
        id: la.id, name: la.name, state: la.state,
        timezone: la.timezone || 'America/Los_Angeles', unstaffed: !!la.unstaffed,
      };
    }
  }
  return null;
}

// Bulk version for list screens: one pair of queries instead of one per row.
// Returns a synchronous predicate (zip) => boolean with the SAME rules as
// resolveServiceArea, including the LA fallback, so the estimates list and the
// per-estimate panel can never disagree about what is brokerable.
export async function unstaffedZipMatcher(db, businessId, businessSlug) {
  const { data: areas, error: aErr } = await db.from('service_areas')
    .select('id, state, unstaffed').eq('business_id', businessId).eq('active', true);
  if (aErr) throw aErr;
  const unstaffedIds = new Set((areas || []).filter(a => a.unstaffed).map(a => a.id));
  // Is the CA (Los Angeles) area present AND unstaffed? Drives the fallback.
  const laUnstaffed = (areas || []).some(a => a.state === 'CA' && a.unstaffed);

  const { data: zips, error: zErr } = await db.from('service_area_zips')
    .select('postal_code, service_area_id').eq('business_id', businessId);
  if (zErr) throw zErr;
  const zipToArea = new Map((zips || []).map(z => [z.postal_code, z.service_area_id]));

  return function isUnstaffed(rawZip) {
    const zip = zip5(rawZip);
    if (!zip) return false;
    if (zipToArea.has(zip)) return unstaffedIds.has(zipToArea.get(zip));
    // No per-zip row: LA fallback only, and only for handy-andy.
    return businessSlug === 'handy-andy' && laUnstaffed && CA_ZIP_RE.test(zip);
  };
}

// "Does this estimate get the brokering flow?" The rule in the owner's words
// is "every location except Denver, Austin and Houston", but it is encoded as
// service_areas.unstaffed so that staffing a market is a single flag flip and
// no code changes. Never hardcode a city list here.
// Unknown/uncovered zip => false: we do not broker work we cannot place.
export async function isUnstaffedZip(db, businessId, businessSlug, rawZip) {
  const area = await resolveServiceArea(db, businessId, businessSlug, rawZip);
  return !!(area && area.unstaffed);
}
