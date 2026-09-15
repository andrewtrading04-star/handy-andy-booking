import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
const missingColumnSource = source.slice(source.indexOf('function missingColumn('), source.indexOf('// ── Dashboard summary'));
const zipAreaSource = source.slice(source.indexOf('async function zipArea('), source.indexOf('// ── Address autocomplete'));
assert.ok(missingColumnSource && zipAreaSource, 'test the production functions');
const zipArea = vm.runInNewContext(`${missingColumnSource}\n${zipAreaSource}\nzipArea;`, {
  resolveBusiness: async () => ({ id: 'business-1', slug: 'doms' }),
  bail: (res, err) => res.status(err.status || 500).json({ error: err.message }),
});
const area = { service_area_id: 'area-1', service_area: { name: 'Denver' } };
const missingSurcharge = { code: '42703', message: 'column service_area_zips.surcharge does not exist' };
const alternate = { business: { slug: 'handy-andy', name: 'Handy Andy', active: true }, service_area: { name: 'Houston' }, surcharge: '25.00' };

function fixture(results) {
  const queries = [];
  const queue = [...results];
  const db = {
    from(table) {
      const query = { table, filters: [] };
      queries.push(query);
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(key, value) { query.filters.push(['eq', key, value]); return builder; },
        neq(key, value) { query.filters.push(['neq', key, value]); return builder; },
        limit(value) { query.limit = value; return builder; },
        async maybeSingle() {
          assert.ok(queue.length, 'unexpected database read');
          const result = queue.shift();
          if ('throw' in result) throw result.throw;
          return result;
        },
      };
      return builder;
    },
  };
  const res = {
    status(code) { this.code = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
  return { queries, res, run: (postal = '80202') => zipArea({ query: { business: 'doms', postal_code: postal } }, res, db, {}) };
}

for (const fee of [0, '65.00']) {
  test(`a mapped ZIP keeps its verified ${fee} fee in one read`, async () => {
    const f = fixture([{ data: { ...area, surcharge: fee }, error: null }]);
    await f.run(' 80202 ');
    assert.equal(f.res.code, 200);
    assert.deepEqual(f.res.body, { service_area_id: 'area-1', name: 'Denver', surcharge: Number(fee), other_business: null });
    assert.equal(f.queries.length, 1);
    assert.deepEqual(f.queries[0].filters, [['eq', 'business_id', 'business-1'], ['eq', 'postal_code', '80202']]);
  });
}

test('an unknown ZIP does not repeat the current-business lookup', async () => {
  const f = fixture([{ data: null, error: null }, { data: null, error: null }]);
  await f.run();
  assert.deepEqual(f.res.body, { service_area_id: null, name: null, surcharge: 0, other_business: null });
  assert.equal(f.queries.length, 2);
  assert.ok(f.queries[1].filters.some(([op, key, value]) => op === 'neq' && key === 'business_id' && value === 'business-1'));
});

test('an unknown ZIP retains the active alternate-business hint and its fee', async () => {
  const f = fixture([{ data: null }, { data: alternate }]);
  await f.run();
  assert.deepEqual(f.res.body.other_business, { slug: 'handy-andy', name: 'Handy Andy', area: 'Houston', surcharge: 25 });
  assert.ok(f.queries[1].filters.some(([op, key, value]) => op === 'eq' && key === 'business.active' && value === true));
  assert.equal(f.queries[1].limit, 1);
});

for (const failure of [
  { error: { code: 'XX000', message: 'Database unavailable' } },
  { throw: new Error('connection lost') },
  { error: { code: '42501', message: 'permission denied for surcharge' } },
  { error: { code: '42703', message: 'column service_area_zips.service_area_id does not exist' } },
  { error: { code: 'PGRST204', message: "Could not find the 'name' column of 'service_areas' in the schema cache" } },
  { error: { code: 'PGRST116', message: 'JSON object requested, multiple rows returned' } },
]) {
  const error = failure.error || failure.throw;
  test(`ZIP read failure cannot become a zero-fee answer: ${error.message}`, async () => {
    const f = fixture([failure]);
    await assert.rejects(f.run(), actual => actual === error);
    assert.equal(f.res.body, undefined);
    assert.equal(f.queries.length, 1, 'no unsafe area-only fallback or alternate-business read');
  });
}

for (const failure of [
  { error: missingSurcharge },
  { throw: missingSurcharge },
  { error: { code: 'PGRST204', message: "Could not find the 'surcharge' column of 'service_area_zips' in the schema cache" } },
]) {
  test(`verified legacy surcharge absence still resolves the area (${failure.throw ? 'throw' : failure.error.code})`, async () => {
    const f = fixture([failure, { data: area }]);
    await f.run();
    assert.equal(f.res.code, 200);
    assert.equal(f.res.body.name, 'Denver');
    assert.equal(f.res.body.surcharge, 0);
    assert.equal(f.queries.length, 2);
    assert.doesNotMatch(f.queries[1].columns, /surcharge/);
  });
}

for (const failure of [{ error: { code: 'XX000', message: 'legacy lookup failed' } }, { throw: new Error('legacy connection lost') }]) {
  test(`a failed legacy fallback is an error: ${(failure.error || failure.throw).message}`, async () => {
    const f = fixture([{ error: missingSurcharge }, failure]);
    await assert.rejects(f.run(), actual => actual === (failure.error || failure.throw));
    assert.equal(f.res.body, undefined);
    assert.equal(f.queries.length, 2);
  });
}

test('the alternate-business hint also works on a verified legacy schema', async () => {
  const { surcharge, ...legacyAlternate } = alternate;
  const f = fixture([{ error: missingSurcharge }, { data: null }, { data: legacyAlternate }]);
  await f.run();
  assert.equal(f.res.body.other_business.slug, 'handy-andy');
  assert.equal(f.res.body.other_business.surcharge, 0);
  assert.doesNotMatch(f.queries[2].columns, /surcharge/);
});

for (const failure of [{ error: { message: 'hint unavailable' } }, { throw: new Error('hint connection lost') }]) {
  test(`optional alternate lookup failure does not undo a verified no-match (${failure.throw ? 'throw' : 'error object'})`, async () => {
    const f = fixture([{ data: null }, failure]);
    await f.run();
    assert.equal(f.res.code, 200);
    assert.equal(f.res.body.other_business, null);
    assert.equal(f.res.body.service_area_id, null);
  });
}

test('a selected modern fee must be present and numeric', async () => {
  for (const surcharge of [undefined, null, '', 'invalid']) {
    const f = fixture([{ data: { ...area, surcharge } }]);
    await assert.rejects(f.run(), /Could not verify the travel fee/);
    assert.equal(f.res.body, undefined);
  }
});

test('an invalid alternate-business fee is omitted with its optional hint', async () => {
  const f = fixture([{ data: null }, { data: { ...alternate, surcharge: null } }]);
  await f.run();
  assert.equal(f.res.body.other_business, null);
});

test('blank ZIP keeps the existing empty answer without database reads', async () => {
  const f = fixture([]);
  await f.run(' ');
  assert.deepEqual(f.res.body, { service_area_id: null, name: null, surcharge: 0 });
  assert.equal(f.queries.length, 0);
});
