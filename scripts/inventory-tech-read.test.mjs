import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createInventoryTestDb, ids } from './lib/inventory-test-db.mjs';
import { apiDb } from './lib/inventory-api-test-db.mjs';
import { syncBracketOrder } from '../api/_lib/bracket-moves.js';

test('actual technician inventory controller shows outstanding receipts across all pages and surfaces read failures', async () => {
  const pg = await createInventoryTestDb();
  try {
    const db = apiDb(pg), source = await readFile(new URL('../api/tech.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function bracketInventory('), end = source.indexOf('// Tech sets their OWN wire-plate count', start);
    assert(start >= 0 && end > start);
    const context = vm.createContext({ console });
    vm.runInContext(source.slice(start, end), context);
    const invoke = async (client = db) => {
      const res = { status(n) { this.code = n; return this; }, json(value) { this.body = value; return this; } };
      await context.bracketInventory({ method: 'GET' }, res, client, { tech_id: ids.a, business_id: ids.business });
      return res;
    };
    const base = { orderNum: '2000000-12345678', business_id: ids.business, technician_id: ids.a, source: 'manual', occurred_at: new Date().toISOString() };
    await syncBracketOrder(db, { ...base, event_id: 'new', ordered: { flat: 4, tilting: 2, full_motion: 1 }, status: 'in_route' });
    await syncBracketOrder(db, { ...base, event_id: 'partial', received: { flat: 2, tilting: 1, full_motion: 1 }, receipt_verified: true, receipt_scope: 'cumulative', status: 'in_route' });
    await pg.exec(`insert into app.bracket_purchases(business_id,technician_id,walmart_order_num,status,flat_qty)
      select '${ids.business}','${ids.a}','open-'||n,'ordered',1 from generate_series(1,1001) n;
      insert into app.bracket_purchases(business_id,technician_id,walmart_order_num,status,inventory_status,flat_qty) values
      ('${ids.business}','${ids.a}','delivered-review','delivered','review',50),
      ('${ids.business}','${ids.a}','canceled','canceled','recorded',50),
      ('${ids.otherBusiness}','${ids.b}','other-tech','in_route','recorded',50);`);
    const res = await invoke();
    assert.equal(res.code, 200);
    assert.equal(res.body.flat, 2); assert.equal(res.body.tilting, 1); assert.equal(res.body.full_motion, 1);
    assert.equal(res.body.in_route.length, 1002);
    const partial = res.body.in_route.find(p => p.order_num === base.orderNum);
    assert.equal(partial.flat, 2); assert.equal(partial.tilting, 1); assert.equal(partial.full_motion, 0);
    assert(!res.body.in_route.some(p => ['delivered-review', 'canceled', 'other-tech'].includes(p.order_num)));
    const broken = { ...db, from(table) {
      if (table !== 'bracket_purchases') return db.from(table);
      const query = { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, range() { return this; },
        then(resolve) { return resolve({ data: null, error: new Error('Shipment read failed') }); } };
      return query;
    } };
    await assert.rejects(invoke(broken), /Shipment read failed/);
  } finally { await pg.close(); }
});
