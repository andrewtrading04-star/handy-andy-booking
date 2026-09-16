# Bracket inventory repair

This release covers flat, tilting and full-motion brackets. It does not certify the physical contents of any technician's truck. Existing quantities are preserved by the migrations; historical uncertainty is exposed for review.

## Required deployment order

1. Export the current inventory, purchases, movements and relevant job material records. Compare the production schema with the four migrations before applying them.
2. Apply migrations 0112, 0113, 0114 and 0115 together. `scripts/build-inventory-release.mjs` builds and tests a single-transaction bundle. It checks that both first application and reapplication preserve quantities and the original cutover date.
3. Deploy the matching API, dashboard, technician app and email workflow code together. Do not deploy only the HTML or only the email parser.
4. Enter verified full shipping addresses, including unit numbers, in the owner dashboard. Old street-number/ZIP guesses are not imported as trusted addresses.
5. Check actual Walmart confirmation, partial-shipment, delivery and cancellation samples. Unsupported or ambiguous messages must appear in review without moving stock.
6. Confirm actual on-hand quantities with each technician and record a physical count for each type. Reconcile historical purchases/jobs against that checkpoint and the original evidence. Do not rerun retired stock-reset scripts or mass-replay old completions.
7. Verify a new receipt, early material-use confirmation, completed job, edited quantity, supplier correction and stale-screen rejection. Also check two real concurrent database sessions in staging; embedded PostgreSQL tests serialize requests on one connection.

## Accounting rules

- Orders and receipts are separate. Only verified cumulative receipts credit stock; retries do not credit twice. Canceling the undelivered remainder does not subtract delivered brackets.
- Job changes, line-item replacement, price/tax totals, material allocation and revision updates share a database transaction. Failed transactions save none of those changes.
- A technician can confirm bracket use before collecting payment or taking completion photos. Completion reconciles the same allocation.
- A completed job's quantity edit reconciles the recorded allocation. Supplier correction returns only the stock actually deducted, then applies the new allocation. Historical or uncertain corrections require review.
- Physical counts change only selected types, require the current record version and establish verification timestamps. Older events cannot silently change a newer count.
- Current physical transfers are distinct from correcting an old receipt's recipient. Recipient correction checks immutable receipt timing against physical-count boundaries on both trucks.
- Low stock is 2 or fewer **of each type**. Incoming stock is shown separately and does not hide the low-stock warning. All open shipments are loaded independently of paginated history.
- Shipping-address edits require a version and a stable request ID. An address cannot silently be claimed by a different technician.

## Database and API entry points

`inventory_job_write`, `ingest_bracket_order`, `inventory_recount`, `inventory_transfer`, `inventory_reassign` and `inventory_shipping_address_save` are server-only transaction entry points. Protected counters and movement records reject direct edits. Existing adjacent wire-plate and Apple TV counters are outside this three-bracket ledger.

`inventory_events` records replay identity and results. `bracket_job_allocations` tracks desired and applied material quantities. `inventory_exceptions` holds unresolved uncertainty. `inventory_legacy_entities` prevents old completed jobs and old receipts from being replayed as new stock movements.

The email scan reads Gmail All Mail, keeps durable message identities, recovers from its persisted successful checkpoint, verifies sender provenance, and reports partial failures. Do not treat a successful inbox login as proof that every order was accounted for.

## Validation

Run `npm ci --ignore-scripts`, `npm run test:inventory`, and `node scripts/build-inventory-release.mjs`. The inventory suite executes the shipped classifiers, UI handlers, API controllers and migrations against local PostgreSQL through PGlite. It includes injected failures, retries, stale edits, partial receipts, receipt timing, supplier cycles, address conflicts and permission checks.

Production deployment, real email-template verification and physical-count reconciliation are separate from those automated tests. Preserve snapshots and the append-only history if a live issue occurs; do not erase movements or reset quantities to an old screenshot.
