// /api/reviews.js
// PUBLIC, read-only feed of real Google reviews for one GBP listing.
//
// Consumed by the marketing sites (ihandyandy.com first, Dom's next) to render
// the newest real reviews on the page that matches the listing — e.g. the
// Greenway Plaza page shows the Greenway Plaza listing's reviews, not a set of
// invented testimonials.
//
// Source is app.google_reviews, ingested from the Google Business Profile
// notification emails by scripts/bracket-email-sync.mjs (every 15 min) and
// attributed to a listing by migration 0108. This endpoint never talks to
// Google; it only reads what that pipeline already stored.
//
//   GET /api/reviews?business=handy-andy&location=ha-greenway&limit=3
//
// No auth: everything it returns is already public on Google Maps. It exposes
// only the reviewer name, rating, text and date — never the technician or
// booking a review is attributed to internally.
import { serviceClient } from './_lib/supabase.js';
import { GMB_LOCATIONS, LOCATIONS_BY_KEY } from '../scripts/lib/gmb-locations.mjs';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 12;

// Google's own placeholder for a star-only review with no words. It is stored
// verbatim by the parser (sometimes with the reviewer's handle prefixed, e.g.
// "(Gooner805) This user only left a rating"), and there is nothing to display.
const RATING_ONLY_RE = /only left a rating/i;

// The email parser is best-effort about where the review text starts, and
// occasionally clips a fragment out of the surrounding boilerplate ("he
// services"). Anything this short is a parse artifact, not a review — the real
// short ones ("Great work all around 100%") clear this comfortably.
const MIN_TEXT_LEN = 20;

function displayable(r) {
  const t = (r.review_text || '').trim();
  return t.length >= MIN_TEXT_LEN && !RATING_ONLY_RE.test(t);
}

// "James Jenkins" -> "James J." — the sites have always shown reviews this way.
// The full name is returned too; it is public on Google either way.
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Google user';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// One reviewer, one card. Several people here have left a review on more than
// one listing (Gregory Sherod has five, one per Handy Andy profile), and the
// same name repeated down a row of cards reads as fabricated — the exact
// impression this whole change exists to remove.
function reviewerKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shape(r, fromThisLocation) {
  return {
    author: r.reviewer_name || 'Google user',
    author_short: shortName(r.reviewer_name),
    rating: r.rating,
    text: (r.review_text || '').trim(),
    date: r.review_date,
    // False when the review came from a sibling listing to top up a thin one.
    // The caller can use this to soften the location line ("Houston, TX"
    // instead of "Greenway Plaza") rather than implying it was left there.
    from_this_location: !!fromThisLocation,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const q = req.query || {};
  const locationKey = (q.location || '').toString().trim() || null;
  const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(q.limit, 10) || DEFAULT_LIMIT));

  const listing = locationKey ? LOCATIONS_BY_KEY.get(locationKey) : null;
  if (locationKey && !listing) return res.status(404).json({ error: `Unknown location "${locationKey}"` });

  // The listing decides the business; ?business= is only used when asking for a
  // brand-wide feed with no location.
  const slug = listing ? listing.business : ((q.business || '').toString().trim() || 'handy-andy');

  try {
    const db = serviceClient();
    const { data: biz } = await db.from('businesses').select('id, slug').eq('slug', slug).maybeSingle();
    if (!biz) return res.status(404).json({ error: `Unknown business "${slug}"` });

    // Over-fetch: the rating-only placeholders and parse fragments are filtered
    // in JS (they're a text predicate the index can't serve), so asking for
    // exactly `limit` rows would come back short.
    const base = () => db.from('google_reviews')
      .select('reviewer_name, rating, review_text, review_date, created_at, location_key')
      .eq('business_id', biz.id)
      .eq('rating', 5)
      .order('review_date', { ascending: false })
      .order('created_at', { ascending: false });

    const usedReviewers = new Set();
    const picked = [];
    if (listing) {
      const { data, error } = await base().eq('location_key', listing.key).limit(60);
      if (error) throw error;
      for (const r of (data || [])) {
        if (picked.length >= limit) break;
        if (!displayable(r)) continue;
        const rk = reviewerKey(r.reviewer_name);
        if (rk && usedReviewers.has(rk)) continue;
        if (rk) usedReviewers.add(rk);
        picked.push(shape(r, true));
      }
    }

    // Top up a thin listing from the brand's newest reviews so a page never
    // renders a half-empty row. Only ever a top-up: reviews genuinely left on
    // this listing always come first, and each one is flagged so the caller
    // knows which is which.
    //
    // This matters most right now: reviews ingested before migration 0108 have
    // no location at all, so every listing reads as empty while the brand has
    // plenty. It also covers a listing that is simply new.
    //
    // THE SLICE, and why it isn't just "the newest N": every listing topping up
    // from one shared pool would hand every page the SAME three reviews. Nine
    // pages showing identical review text is duplicate content — worse than the
    // invented-but-varied testimonials this replaced. So each listing draws from
    // a DISJOINT window of the pool, offset by its position in the registry.
    // Every page still gets real, recent reviews; no two pages get the same set.
    // Deterministic, so a page doesn't reshuffle on every revalidate.
    let toppedUp = 0;
    if (picked.length < limit) {
      const { data, error } = await base().limit(120);
      if (error) throw error;

      // Collapse to one entry per reviewer (their newest) BEFORE slicing.
      // Slicing first doesn't work: the pool is date-ordered, and a reviewer
      // with several reviews occupies a consecutive run of it — Gregory Sherod
      // has five in two days. Two different offsets can land inside the same
      // run, get deduped down to the same survivors, and hand two listings an
      // identical set anyway, which is the bug this slice exists to prevent.
      const byReviewer = new Map();
      for (const r of (data || [])) {
        if (!displayable(r)) continue;
        if (listing && r.location_key === listing.key) continue; // already taken above
        const rk = reviewerKey(r.reviewer_name);
        if (rk && usedReviewers.has(rk)) continue; // already on this page
        if (rk && byReviewer.has(rk)) continue;    // keep their newest only
        byReviewer.set(rk || `anon-${byReviewer.size}`, r);
      }
      const pool = [...byReviewer.values()];

      const siblings = GMB_LOCATIONS.filter((l) => l.business === slug);
      const idx = listing ? Math.max(0, siblings.findIndex((l) => l.key === listing.key)) : 0;
      const offset = pool.length ? (idx * limit) % pool.length : 0;

      for (let n = 0; n < pool.length && picked.length < limit; n++) {
        const r = pool[(offset + n) % pool.length];
        const rk = reviewerKey(r.reviewer_name);
        if (rk && usedReviewers.has(rk)) continue;
        if (rk) usedReviewers.add(rk);
        picked.push(shape(r, false));
        toppedUp++;
      }
    }

    // Cheap and safe to cache: the upstream ingest runs every 15 minutes, so a
    // 10-minute edge cache never hides a review for meaningfully longer than
    // the pipeline already does.
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({
      ok: true,
      business: slug,
      location: listing ? {
        key: listing.key,
        name: listing.name,
        display_name: listing.displayName,
        // The listing's Maps page — what a "see our reviews" link should open.
        maps_url: listing.mapsUrl,
        // Google's WRITE-a-review dialog. Kept for the CRM's review requests;
        // a website should not send a reader here.
        review_url: listing.reviewUrl,
        phone: listing.phone,
        address: listing.address,
        // Hand-checked snapshot of what Google publicly shows for this listing
        // — see the note in gmb-locations.mjs. NOT a count of the rows above.
        rating: listing.rating,
        review_count: listing.reviewCount,
        stats_verified: listing.statsVerified,
      } : null,
      count: picked.length,
      topped_up: toppedUp,
      reviews: picked,
    });
  } catch (e) {
    console.error('[reviews]', (e && e.stack) || e);
    return res.status(500).json({ error: 'Could not load reviews' });
  }
}
