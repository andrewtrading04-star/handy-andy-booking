-- ============================================================================
-- Per-subcontractor rate card (extends the brokering feature, migration 0092).
--
-- The owner is researching what each company charges for the three cost
-- drivers on a TV mount: the size tier, the bracket, and the wire concealment.
-- Those prices belong to the COMPANY, not to one estimate, so once a company's
-- card is filled in every future estimate prices itself.
--
-- Keys are (section_key, row_key) straight out of app.widget_prices, which is
-- the catalog the booking widget already uses (size_1..size_6, bracket_10..17,
-- wires_40..43 for handy-andy). Reusing those keys means a rate card cell
-- always lines up with a real, selectable option, and renaming an option's
-- LABEL later does not orphan the price -- which matters, because the wires
-- labels were already edited once (an Aug 11 estimate still reads "Yes, hide
-- the wires OUTSIDE the wall" while the catalog now says "Hide wires OUTSIDE
-- the wall").
--
-- Ships EMPTY. Every price here is typed in by a human.
-- ============================================================================

create table if not exists app.subcontractor_rates (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references app.businesses(id),
  subcontractor_id uuid not null references app.subcontractors(id) on delete cascade,
  -- Only the three sections the owner is collecting prices for. A CHECK rather
  -- than a lookup table so an unexpected section fails loudly at write time.
  section_key      text not null check (section_key in ('size', 'bracket', 'wires')),
  row_key          text not null,
  price            numeric not null check (price >= 0),
  updated_at       timestamptz not null default now()
);

-- One price per company per option. The upsert in estimate_broker_save_bid
-- targets this constraint.
create unique index if not exists subcontractor_rates_uniq
  on app.subcontractor_rates (subcontractor_id, section_key, row_key);

create index if not exists subcontractor_rates_biz_idx
  on app.subcontractor_rates (business_id, subcontractor_id);

-- Which size/bracket/wires option this particular job actually needs. Chosen
-- once per estimate (best-effort prefilled from the estimate's own line items,
-- then correctable by the office), and shared by all three bids so the
-- companies are always quoting the SAME scope as each other.
-- Shape: {"size":"size_3","bracket":"bracket_13","wires":"wires_41"}
alter table app.estimates
  add column if not exists broker_spec jsonb;

-- What the winning company's price was actually made of, snapshotted at book
-- time so a later rate-card edit cannot rewrite history on a booked job.
-- Shape: [{"section_key":"size","row_key":"size_3","label":"60\"-69\"","price":85}, ...]
alter table app.estimate_broker_bids
  add column if not exists breakdown jsonb;
