// Houston-only $70 second-tech bonus (all other metros stay at $60 — see
// payroll.js's SECOND_TECH_BONUS_DEFAULT/HOUSTON). Four brands operate in
// Houston exclusively; Handy Andy and Precision TV also run Denver/Austin/
// DFW/LA/Phoenix/San Antonio, so those two need the actual per-booking metro,
// not just the business, to avoid overpaying non-Houston jobs.
export const HOUSTON_ONLY_SLUGS = new Set([
  'houstonmounting', 'htvmounting', 'houstontvinstallation', 'tvhanginghouston',
]);

// business_id -> Houston service_area id (or null if that business has none),
// cached for the life of the process — service_areas essentially never change.
const houstonAreaIdCache = new Map();

async function houstonAreaIdFor(db, businessId) {
  if (!businessId) return null;
  if (houstonAreaIdCache.has(businessId)) return houstonAreaIdCache.get(businessId);
  const { data } = await db.from('service_areas')
    .select('id').eq('business_id', businessId).ilike('name', 'houston').maybeSingle();
  const id = data?.id || null;
  houstonAreaIdCache.set(businessId, id);
  return id;
}

// Resolve whether a booking counts as a Houston job for payroll purposes.
// businessSlug alone settles it for the four Houston-exclusive brands; Handy
// Andy/Precision (and any other multi-metro business) need the booking's own
// service_area_id compared against that business's Houston service_area.
export async function isHoustonBooking(db, businessId, businessSlug, serviceAreaId) {
  if (HOUSTON_ONLY_SLUGS.has(String(businessSlug || '').toLowerCase())) return true;
  if (!serviceAreaId) return false;
  const houstonId = await houstonAreaIdFor(db, businessId);
  return !!houstonId && houstonId === serviceAreaId;
}
