-- Website contact-form leads (LandingSite) are ingested from email by
-- scripts/lib/website-lead-parse.mjs via api/migrate.js?action=website_lead_sync.
-- The mailbox is re-scanned in full on every run, so each lead needs a stable
-- unique key or every run would insert it again. Holds the email's Message-ID.
alter table app.estimates
  add column if not exists external_key text;

create unique index if not exists estimates_external_key_uniq
  on app.estimates (external_key)
  where external_key is not null;

-- Distinguishes these from real estimate requests (drives the "Website messages"
-- filter and the card variant in public/admin.html).
alter type app.booking_source add value if not exists 'website_form';
