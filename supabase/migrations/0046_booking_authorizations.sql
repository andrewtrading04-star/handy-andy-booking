-- ============================================================================
-- Migration 0046: Signed customer authorizations (chargeback evidence)
-- ----------------------------------------------------------------------------
-- When a tech charges a card at the job, the customer signs for the ticket on
-- the tech's device. We freeze everything Stripe rewards as dispute evidence:
-- the signature image, the exact amount + tip + line items they agreed to, the
-- terms they accepted, and the IP / device / timestamp of the signing.
--
-- One row per successful signed charge, keyed to the booking and the Stripe
-- PaymentIntent so a later chargeback can be answered automatically from here.
--
-- Idempotent. Run after 0045.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists booking_authorizations (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references businesses(id) on delete cascade,
  booking_id               uuid not null references bookings(id)   on delete cascade,

  -- The signature, stored in the same public bucket as job photos.
  signature_path           text,
  signature_url            text,

  -- Who signed and on what card (last4/brand fetched from Stripe at charge time).
  customer_name            text,
  card_brand               text,
  card_last4               text,

  -- The money they authorized. amount = ticket_amount + tip (what we charged).
  amount                   numeric(10,2) not null default 0,
  ticket_amount            numeric(10,2) not null default 0,
  tip                      numeric(10,2) not null default 0,

  -- A frozen snapshot of the exact ticket the customer saw and signed.
  line_items               jsonb,

  -- The authorization / terms language they agreed to, and its version.
  terms_text               text,
  terms_version            text,

  -- Signing provenance — heavily weighted by Stripe on fraud disputes.
  signed_ip                text,
  signed_user_agent        text,
  signed_at                timestamptz not null default now(),

  -- The Stripe objects this authorization backs.
  stripe_payment_intent_id text,
  stripe_charge_id         text,

  created_at               timestamptz not null default now()
);

create index if not exists booking_authorizations_booking_idx
  on booking_authorizations(booking_id);
create index if not exists booking_authorizations_pi_idx
  on booking_authorizations(stripe_payment_intent_id);
