// Generator for migration 0032 — native service-area zips (Handy Andy all metros
// + Doms Denver), each zip tagged with a travel surcharge AND the tech payout.
// Run: node scripts/gen-0032-areas.mjs > supabase/migrations/0032_native_service_areas.sql
// The zip tiers below are exactly as provided by the owner.

// tier = [surcharge, tech_payout]
const T = {
  d1: [0, 0], d2: [15, 10], d3: [65, 50], d4: [100, 75],
  h1: [0, 0], h2: [15, 10], h3: [65, 50],
  a1: [0, 0], a2: [15, 10], a3: [65, 50], a4: [100, 75],
};

const DENVER = {
  d1: `80210 80208 80222 80209 80150 80151 80155 80113 80223 80246 80224 80110 80206 80218 80219 80237 80203 80231 80236 80121 80247 80248 80250 80256 80259 80261 80263 80217 80243 80291 80271 80273 80274 80281 80201 80220 80264 80290 80230 80293 80165 80166 80160 80161 80299 80257 80204 80265 80294 80202 80205 80120 80111 80014 80207 80122 80211 80123 80232 80040 80044 80012 80226 80235 80010 80214 80046 80162 80216 80212`,
  d2: `80227 80045 80238 80047 80042 80034 80266 80225 80215 80112 80041 80129 80130 80128 80163 80126 80017 80221 80011 80228 80037 80033 80239 80015 80013 80124 80002 80001 80006 80036 80030 80035 80003 80024 80229`,
  d3: `80004 80419 80260 80465 80131 80125 80127 80016 80031 80402 80640 80453 80005 80401 80018 80019 80233 80454`,
  d4: `80306 80307 80308 80314 80309 80310 80304 80305 80301 80303`,
};

const HOUSTON = {
  h1: `77011 77023 77003 77020 77204`,
  h2: `77010 77012 77004 77201 77202 77203 77029 77052 77002 77206 77207 77208 77210 77212 77213 77215 77216 77217 77219 77220 77221 77222 77223 77224 77225 77226 77227 77228 77229 77230 77231 77233 77234 77235 77236 77237 77238 77240 77241 77242 77243 77244 77245 77248 77249 77251 77252 77253 77254 77255 77256 77257 77258 77259 77261 77262 77263 77265 77266 77267 77268 77269 77270 77271 77272 77273 77274 77275 77277 77279 77280 77282 77284 77287 77288 77289 77290 77291 77292 77293 77297 77299 77001 77087 77026 77021 77547 77006 77009 77017 77033 77013 77028 77030 77019 77061 77007 77098 77506 77005 77508 77501`,
  h3: `77051 77022 77587 77054 77046 77008 77502 77016 77078 77093 77027 77025 77048 77075 77018 77015 77402 77076 77056 77401 77503 77504 77045 77047 77081 77057 77034`,
};

const AUSTIN = {
  a1: `78729 78651 78717 78727 78728 78750 78759 78613 78630 78681 78683 78726 78758 78680 78682 78753 78757 78664 78731 78691 78730 78665 78752 78754 78646 78756 78660 78732 78751 78710 78641 78723 78705 78703 78746 78722 78712 78733 78645 78734 78701 73344 78713 78714 78715 78716 78708 78709 78711 78718 78720 78755 78760 78761 78762 78763 78764 78765 78766 78767 78768 78772 78773 78774 78778 78779 78783 78799 78627 78628 78702 78721`,
  a2: `78634 78724 78735 78704`,
  a3: `78653 78741 78742 73301 78725 78736 78738 78626 78745`,
  a4: `78674 78749 78744 78633 78642 78748 78739`,
};

const zips = s => s.trim().split(/\s+/);

// Build (slug, area, zip, surcharge, payout) rows. Handy Andy gets all three
// metros; Doms gets the SAME Denver list (Doms is Denver-only).
const rows = [];
const seen = new Set(); // dedupe per (slug,zip): last tier wins is avoided by skipping dupes
function add(slug, area, tierMap) {
  for (const [tier, list] of Object.entries(tierMap)) {
    const [surcharge, payout] = T[tier];
    for (const z of zips(list)) {
      const k = `${slug}:${z}`;
      if (seen.has(k)) { console.error(`DUPLICATE ${slug} ${z} (tier ${tier}) — skipped`); continue; }
      seen.add(k);
      rows.push({ slug, area, zip: z, surcharge, payout });
    }
  }
}
add('handy-andy', 'Denver', DENVER);
add('handy-andy', 'Houston', HOUSTON);
add('handy-andy', 'Austin', AUSTIN);
add('doms', 'Denver', DENVER);

const valuesSql = rows
  .map(r => `  ('${r.slug}','${r.area}','${r.zip}',${r.surcharge},${r.payout})`)
  .join(',\n');

const counts = {};
for (const r of rows) { const k = `${r.slug}/${r.area}/${r.surcharge}`; counts[k] = (counts[k] || 0) + 1; }
console.error('Row counts by slug/area/surcharge:', JSON.stringify(counts, null, 2));
console.error('TOTAL rows:', rows.length);

process.stdout.write(`-- ============================================================================
-- Migration 0032: Native service areas for Handy Andy (all metros) + Doms Denver
-- ----------------------------------------------------------------------------
-- Moves Handy Andy's public booking widget off Zenbooker the same way Doms
-- already is: zip validation + per-zip TRAVEL SURCHARGE come from the CRM's own
-- service_area_zips table. Adds the TECH PAYOUT half of each travel tier (the
-- "\$X paid to the tech" amount) and a per-booking stripe_account marker so a
-- booking's card is always charged from the Stripe account it was saved in.
--
-- Tiers (surcharge to customer / payout to tech), exactly as provided:
--   Denver  #1 0/0   #2 15/10  #3 65/50  #4 100/75
--   Houston #1 0/0   #2 15/10  #3 65/50
--   Austin  #1 0/0   #2 15/10  #3 65/50  #4 100/75
-- Doms is Denver-only and uses the SAME Denver tiers.
--
-- Idempotent: ALTERs use IF NOT EXISTS; the seed uses ON CONFLICT DO UPDATE so a
-- re-run with a corrected list overwrites surcharge/payout/area in place. Doms'
-- old placeholder zips (migration 0031) are cleared first so only this list
-- remains. Generated by scripts/gen-0032-areas.mjs — edit there, not here.
--
-- Run after 0031.
-- ============================================================================
set search_path = app, public, extensions;

-- 1) Tech payout per zip (dollars). Default 0 so existing rows are unaffected.
alter table service_area_zips
  add column if not exists tech_payout numeric(10,2) not null default 0;

-- 2) Which Stripe account holds a booking's card-on-file. NULL = legacy behavior
--    (Handy Andy -> global STRIPE_SECRET_KEY, Doms -> DOMS_STRIPE_SECRET_KEY).
--    New native bookings stamp this explicitly ('handy-andy' | 'doms' | 'global').
alter table bookings
  add column if not exists stripe_account text;

-- 3) Clear Doms' old placeholder zips (0031) so Doms follows ONLY the list below.
delete from service_area_zips
where business_id = (select id from businesses where slug = 'doms');

-- 4) Seed all zips. One row per (business, zip); zip -> area -> surcharge + payout.
insert into service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout)
select b.id, sa.id, v.zip, v.surcharge, v.payout
from (values
${valuesSql}
) as v(slug, area, zip, surcharge, payout)
join businesses b on b.slug = v.slug
join service_areas sa on sa.business_id = b.id and sa.name = v.area
on conflict (business_id, postal_code) do update
  set surcharge       = excluded.surcharge,
      tech_payout     = excluded.tech_payout,
      service_area_id = excluded.service_area_id;

-- ============================================================================
-- DONE. Verify with:
--   select b.slug, sa.name, z.surcharge, z.tech_payout, count(*)
--     from service_area_zips z
--     join businesses b on b.id = z.business_id
--     join service_areas sa on sa.id = z.service_area_id
--    group by b.slug, sa.name, z.surcharge, z.tech_payout
--    order by b.slug, sa.name, z.surcharge;
-- ============================================================================
`);
