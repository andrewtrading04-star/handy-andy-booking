-- ============================================================================
-- Tech-leaves-a-Google-review tracking, for the "Leave us a review" card in
-- the tech app's Reviews tab. A tech self-reports having left a review for
-- one of the company's Google listings (checkbox, timestamped); this is
-- reconciled against real review-notification emails landing in that
-- listing's own Gmail inbox (see scripts/bracket-email-sync.mjs -- the same
-- mailboxes it already reads for order emails are labeled by listing there)
-- so a claim can be marked confirmed rather than trusted blindly.
--
-- One row per (technician, listing). listing_key is a short fixed string
-- (ha-houston-1, ha-houston-2, ha-austin, ha-denver-1, ha-denver-2, doms) --
-- not a foreign key, since the listing set lives in code (GMB_LISTINGS in
-- api/admin.js), not a database table; there is no need for a listings
-- table when the set changes by code deploy, same reasoning bracket types
-- and travel-fee tiers already follow elsewhere in this schema.
-- ============================================================================

create table if not exists app.tech_review_checkins (
  id            uuid primary key default gen_random_uuid(),
  technician_id uuid not null references app.technicians(id),
  listing_key   text not null,
  checked_at    timestamptz not null default now(),
  -- Set by the (future) email-reconciliation pass, never by the tech's own
  -- request -- a tech can check the box but can't mark themselves confirmed.
  confirmed_at  timestamptz,
  confirmed_via text,          -- e.g. 'gmail_notification'
  unique (technician_id, listing_key)
);

create index if not exists tech_review_checkins_listing_idx
  on app.tech_review_checkins (listing_key, checked_at desc);
