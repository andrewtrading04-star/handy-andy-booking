# Bracket inventory: why it keeps breaking, and the fix

Audit date: 2026-09-03. Trigger: order 2000153-74717131 (2 full motion for TK) showed "2 left" after delivery. Root cause of that incident: the Sept 2 retroactive backfill re-deducted July jobs that a raw-SQL physical reset on July 7 had already absorbed. Corrected the same day (TK +4 FM, Greg +1 flat, Juan +2 tilt +2 FM, Steve +1 tilt). Kregg and Zach never had a physical reset, so their backfill was legitimate.

Companion data: `docs/bracket-inventory-audit.findings.json` (79 write paths, 54 findings, git-history catalog, skeptic verdicts).

## The owner's invariant

"If I send a tech a bracket their count goes up. If a tech uses a bracket their count goes down."

The system does not implement that invariant. It implements: "a mutable number that ~14 independent pieces of code overwrite, plus a write-only log bolted on later."

## The four structural causes (from 11 fix commits, Jun 28 to Sep 2)

1. **One mutable counter, many uncoordinated writers.** `bracket_inventory.{flat,tilting,full_motion}_qty` is mutated by: tech-app completion, office completion, office line-item reconcile, tech supplier picker, office "Set Brackets" modal, tech `bracket_inventory_set`, `bracketAssign`, `bracketSetStatus`, `bracketParseEmail`, the Walmart sync (`migrate.js`), two raw SQL scripts, and the demo seed. Four separate JS copies of `adjustBracketInventory` exist (admin.js, tech.js, migrate.js, plus the assign path) and must be kept in sync by hand. Every new writer has re-discovered a gap (no supplier, cross-business, no stamp, no ledger).
2. **No source of truth.** `bracket_usage_logs` was added 2026-08-21 as a best-effort side effect. It stores unsigned quantities, records **zeros** for every manual set and correction (the delta lives only in prose), has **no rows at all for deliveries**, and nothing reads it. It cannot be summed to reproduce a count, so no reconciliation is possible and no backfill can know what a reset already absorbed. Raw SQL resets leave no trace anywhere.
3. **Idempotency by convention, not by key.** Job deductions are guarded by a JSONB stamp (`metadata.bracket_deducted_at`) written non-atomically after the counter, and overwritten whole by unrelated handlers. Delivery credits are guarded by the mutable `status` column on `bracket_purchases`, which the owner can also flip by hand. There is no unique key on (booking, tech) usage, none on `walmart_order_num`, no `credited` marker, no CHECK that quantities stay >= 0. The DB enforces nothing but foreign keys.
4. **Consumption is derived by regex over free text, at one instant.** Bracket counts are inferred from line-item names ("flat", "tilt", "full motion") at completion. Duplicate lines, hand-typed lines, estimate upsell lines, "flat-pack dresser", and the office vs tech editors all produce different numbers. Payroll has its own matcher. Nothing stores "this job consumed N of type T from tech X" as a fact.

## Findings (54, by severity; 24 of 26 completed skeptic checks upheld the finding)

Verification of the remaining 28 was cut off by the account usage limit; treat them as strong but unverified.

**High (structurally certain to recur)**
- DD-1 / RB-1 / HP-1: raw reset followed by retroactive backfill double-debits (this incident).
- RB-2: a UI "Set Brackets" reset is equally invisible to a later backfill (ledger row carries zeros, no booking link).
- RB-4: manual reset followed by supplier change or line-item reconcile re-applies original quantities on top of the reset.
- RB-5: no usable per-booking idempotency key for backfills (stamp can be absent, erased by whole-metadata writes, or stripped by reopen).
- C1 / HP-4: owner flips the Walmart dropdown to Delivered on an auto-assigned order: never credited, and the sync will never credit it (latch set). Confirmed by skeptic.
- C2: owner downgrades a delivered order to In route: next cron re-credits the whole order. Confirmed.
- C3 / CBI-1: assigning from the other company's tab credits a phantom (wrong-business) row. Same class as the 2026-07-16 fix. Confirmed.
- DD-2 / MD-3 / HP-3: office "Mark complete" on a two-tech job always charges the primary tech; the tech supplier picker then deducts again from the real supplier.
- MD-1: bracket added after a zero-bracket completion is never debited (reconcile only arms if the first completion found brackets).
- MD-2 / detection DD-1: tech-app line-item edit on a completed job never touches inventory; only the office editor reconciles.
- MD-4 / HP-8: office completes a job with no tech: logged "needs manual attribution" to a table nobody reads; never debited.
- HP-2: the ledger is write-only; clamp warnings and unattributed rows never surface.
- Concurrency: office double-click on Mark complete, or office + tech completing within the same request window, both pass the stale stamp check and deduct twice; double-click on Assign credits twice (no credited marker). Confirmed.
- Stale "Set Brackets" modal writes all three columns from page-render values, reverting any move that landed while it was open. Confirmed.
- Detection DD-2 / double-debit DD-3: estimate "upgrade to tilting/full motion" upsell persists as a second bracket line; N+1 deducted for N TVs.

**Medium**
- C4: canceled after delivery credit stays on the count forever; a false "cancel" match on an in-route order blocks its credit forever.
- C5: `bracket_parse_email` credits at order time and on every re-submit (dead endpoint, but live code). Confirmed.
- C6: sync credits inventory before persisting status, swallows the status-write error; cron has no concurrency group. Structural cause confirmed, headline overlap refuted on operational grounds.
- C7: rolling 45-day email window turns a parse difference between confirmation and delivery emails into a silent debit or credit weeks later. Refuted in its stated form (parser returns early on a quantity hit); parse-driven moves have happened (c722678).
- C8: Jul 7 policy switch (credit at assignment to credit at delivery) had no per-order "already credited" marker; orders in flight that day were credited twice.
- RB-3 / HP-6: stale modal (see above); RB-6: the raw fix scripts remain in the repo as re-runnable absolute writes with name-prefix matching; RB-7: sync self-heal silently undoes a manual physical correction when a higher-qty email re-appears.
- HP-5: tech edit of a completed job changes ticket and payroll, never the count; HP-7: reopen + cancel keeps the deduction forever, nobody is prompted.
- CBI-2: Inventory tab renders every row so a phantom row shows twice; Edit on the phantom writes the home row; CBI-3: cross-company two-tech office completion charges the wrong company's stock.
- DD-4 / DD-5 / DD-6 (double-debit): reopen-reassign-recomplete-edit moves the debit to the new tech without restoring the old; office reassign racing a tech completion clobbers the stamp; metadata blob rewrites erase the stamp.
- MD-5: hand-typed or catalog bracket lines outside the three-word vocabulary never debit (payroll treats them as a bracket sold). Detection DD-3: tech app relabels wire concealment so neither plate detector matches. Detection DD-4: "flat-pack dresser" x3 hours deducts 3 flat brackets.

**Low**
- RB-8: demo seed deletes production inventory rows and the read path silently re-creates zeros; CBI-4: name-prefix tech lookups; CBI-5: ledger rows keyed to different businesses per helper; DD-7: pre-stamp jobs re-deduct on reopen + recomplete; MD-6: failed counter UPDATE is ignored but ledger and stamp are still written; counter lost-update between any two movers one round trip apart.

## The fix: make drift impossible, not unlikely

Principle: **the count is derived from a ledger of signed movements, and there is exactly one way to add a movement.** Everything below follows from that.

1. **`bracket_moves` is the truth.** Append-only. Columns: technician_id, kind (`opening`, `delivery`, `delivery_reversal`, `job_use`, `job_reversal`, `adjust`, `recount`, `transfer`), signed `flat_delta / tilting_delta / full_motion_delta`, `booking_id`, `purchase_id`, `order_num`, `idempotency_key` UNIQUE NOT NULL, `reason` NOT NULL for adjust/recount/transfer, `actor`, `clamped_*` (how much a debit was cut at zero), `created_at`. Opening-balance rows for the six techs from today's corrected counts (TK 7/4/6, Gregory 5/3/2, Juan 3/7/7, Steve 6/4/3, Kregg 4/3/3, Zach 5/4/3).
2. **One entry point: Postgres function `bracket_move(...)`.** Inserts the ledger row (`ON CONFLICT (idempotency_key) DO NOTHING`, returning the existing row so replays are no-ops), then atomically `UPDATE bracket_inventory SET x = x + delta` on the tech's home-business row, in one transaction. `recount` computes `delta = target - current` inside the function so the ledger always carries the true signed movement and the counter equals what was counted. Clamps at zero but records the clamped amount.
3. **A trigger on `bracket_inventory` rejects any quantity change not made by the function** (session flag set inside `bracket_move`). Raw SQL, the four JS copies, the demo seed, a future "quick fix": all fail loudly. Ship in audit mode first (log offenders to a table), flip to reject after the JS cutover.
4. **Idempotency keys are the protocol.** `job:<booking_id>` for use (a backfill for an already-counted job is a no-op by construction). `job-rev:<booking_id>:<li_rev>` and `job:<booking_id>:<li_rev>` for reconcile after edits. `delivery:<walmart_order_num>` for credit (kills the twin-row, assign-double-click, downgrade-and-re-credit, and parse_email cases in one key). `delivery-adj:<order>:<old>-><new>` for quantity corrections, `delivery-rev:<order>` for cancel-after-credit. `recount:<tech>:<ts>` with a mandatory reason. The function also refuses a `job_use` whose booking completed before the tech's latest `opening`/`recount` move: that count already absorbed it.
5. **Store consumption as a fact.** At completion, write `metadata.brackets_used = {flat, tilting, full_motion, technician_id, li_rev}` on the booking. Reconciliation after an edit compares the new derived quantities to that stored fact and emits `job_use`/`job_reversal` deltas; reassign/reopen/cancel emit reversals against the tech actually charged. One `detectBracketQtys` in `api/_lib/line-items.js`, imported by admin.js, tech.js and payroll; require `option_id` or a whitelisted bracket label rather than a substring match.
6. **Purchases reference their credit.** `bracket_purchases.credited_move_id` FK. The status dropdown calls `bracket_move`; "Delivered" credits, "Canceled" after credit reverses. Unique index on `(walmart_order_num, business_id)`. Cron gets a `concurrency` group.
7. **Recount is a first-class event.** The "Set Brackets" modal becomes "I counted the truck": per-field, with reason, compare-and-swap on `updated_at`, written as a `recount` move. Add "transfer between techs" and "received by hand" so absolute overwrites are never needed.
8. **Drift is loud.** View `bracket_drift` (counter vs `SUM(moves)` per tech) checked nightly; any row, any clamped move, any unattributed job texts the owner through the existing low-stock SMS path and shows as a badge on the Inventory tab.
9. **Delete `scripts/fix-*.sql`**, guard `demo-seed.sql` by project id, remove the dead `bracket_parse_email` action and the tech `bracket_inventory_set` early-return stub.

Migration is zero-count-change: opening balances equal today's counters, the trigger starts in audit mode, cutover replaces call sites one at a time, and `bracket_usage_logs` stays readable for history.

Estimated effort: one focused day (migration + `_lib/bracket-moves.js` + ~12 call sites in admin.js/tech.js/migrate.js + recount modal + drift check), then one day of watching audit-mode logs before flipping the trigger to reject.
