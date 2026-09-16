import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRETARY_EXTRA_BUSINESSES, allowedSlugsFor, mayUseBusiness } from '../api/_lib/staff-access.js';

test('secretary access comes from the current assignment map, not a stale token claim', () => {
  const heather = allowedSlugsFor({ scope:'handy-andy', allowed:['doms', 'old-business'] });
  const joey = allowedSlugsFor({ scope:'doms', allowed:['handy-andy', 'old-business'] });
  assert.deepEqual(heather, ['handy-andy', ...SECRETARY_EXTRA_BUSINESSES['handy-andy']]);
  assert.deepEqual(joey, ['doms', ...SECRETARY_EXTRA_BUSINESSES.doms]);
  assert.equal(mayUseBusiness({ scope:'handy-andy', allowed:['doms'] }, 'doms'), false);
  assert.equal(mayUseBusiness({ scope:'doms', allowed:['handy-andy'] }, 'handy-andy'), false);
});
