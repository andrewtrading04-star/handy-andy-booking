-- ============================================================================
-- ONE-TIME: add Heather's and Joey's real cell numbers to
-- businesses.settings.estimate_notify_phones, so they get texted directly
-- (in addition to/independent of the HANDY_ANDY_SECRETARY_PHONE /
-- DOMS_SECRETARY_PHONE env vars, which this column unions with at send time —
-- see api/estimate.js).
-- ----------------------------------------------------------------------------
-- DO NOT RUN AS-IS. Which number belongs on which business is NOT confirmed.
-- staff_users (migration 0001) seeds Heather on 'handy-andy' and Joey on
-- 'doms', and the existing placeholder numbers already in businesses.settings
-- (migration 0016) happen to match that same pairing — but this script does
-- not assume that's still correct, or that each of them should be texted for
-- only ONE business. Confirm the mapping below, delete whichever option
-- block doesn't apply per business, then run.
--
-- Numbers, normalized to this codebase's bare-10-digit convention for this
-- column (see existing rows seeded in migration 0016):
--   Heather: 17203711561        -> 7203711561
--   Joey:    (303) 219-0118     -> 3032190118
-- ============================================================================
set search_path = app, public, extensions;

-- ── Handy Andy ───────────────────────────────────────────────────────────────
-- Pick ONE of the following (uncomment it), or edit the array to include both
-- numbers if Handy Andy's estimates should text both Heather and Joey.
-- The `||` merge preserves any other keys already in settings and is safe to
-- re-run.

-- Option A — Heather only:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','7203711561'))
-- where slug = 'handy-andy';

-- Option B — Joey only:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','3032190118'))
-- where slug = 'handy-andy';

-- Option C — both:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','7203711561','3032190118'))
-- where slug = 'handy-andy';

-- ── Doms ─────────────────────────────────────────────────────────────────────
-- Same choice, for the Doms business.

-- Option A — Joey only:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','3032190118'))
-- where slug = 'doms';

-- Option B — Heather only:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','7203711561'))
-- where slug = 'doms';

-- Option C — both:
-- update businesses
-- set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','7203711561','3032190118'))
-- where slug = 'doms';

-- Verify:
--   select slug, settings->'estimate_notify_phones' from businesses;
-- ============================================================================
