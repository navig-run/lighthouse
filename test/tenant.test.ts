// The edge's tenant identity — the first tests this Worker has ever had.
//
// Lighthouse is a PUBLIC repo users deploy to their OWN Cloudflare account, and
// it shipped with no test of any kind. These deliberately import only
// `src/tenant.ts`, which has zero imports of its own, so `node --test` runs them
// with no `node_modules` — the same property that lets `services/api`'s suite sit
// in the fast tier. A suite that needs an install is a suite that gets skipped,
// and a skipped suite is documentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { TENANT_RE, isTenantId, sha256Hex } from '../src/tenant.ts';

/** A real tenant, derived the way the brain derives it. */
const REAL = createHash('sha256').update('some-deck-api-key').digest('hex');

test('the derivation matches the brain’s, byte for byte', async () => {
  // `navig/cloud/uplink.py`: "The tenant id Lighthouse routes on: sha256(api_key)
  // as lowercase hex". If the edge and the brain ever disagree here, every
  // webhook silently addresses a Durable Object with no uplink — which is
  // exactly how the bot once went 100% deaf with every light green.
  assert.equal(await sha256Hex('some-deck-api-key'), REAL);
  assert.equal(REAL.length, 64);
  assert.match(REAL, /^[0-9a-f]{64}$/);
});

test('a real tenant id is accepted', async () => {
  assert.equal(isTenantId(REAL), true);
  assert.equal(isTenantId(await sha256Hex('')), true, 'any key, however odd, still hashes');
});

test('anything that is not a hash is refused', async () => {
  const rejected = [
    '',
    'a',
    'not-a-hash',
    REAL.slice(0, 63), // one short
    REAL + '0', // one long
    REAL.toUpperCase(), // the brain emits lowercase; uppercase is a different DO name
    REAL.replace(/.$/, 'g'), // non-hex character
    '../' + REAL,
    REAL + '/../other',
    '%2e%2e%2f' + REAL,
    ' ' + REAL,
    REAL + ' ',
    '0'.repeat(1000),
  ];
  for (const bad of rejected) {
    assert.equal(isTenantId(bad), false, `must refuse ${JSON.stringify(bad.slice(0, 40))}`);
  }
});

test('a missing segment is refused rather than thrown on', async () => {
  assert.equal(isTenantId(undefined), false);
  assert.equal(isTenantId(null), false);
});

test('the pattern is anchored at both ends', async () => {
  // Anti-vacuity partner: an unanchored regex would accept every string above
  // that merely CONTAINS a hash, which is the whole attack.
  assert.equal(TENANT_RE.source.startsWith('^'), true);
  assert.equal(TENANT_RE.source.endsWith('$'), true);
  assert.equal(TENANT_RE.global, false, 'a /g regex carries lastIndex between tests');
});

test('repeated checks of the same value are stable', async () => {
  // A `/g` regex would alternate true/false via lastIndex. Cheap to pin, and the
  // failure mode is a webhook that works every other request.
  for (let i = 0; i < 5; i++) assert.equal(isTenantId(REAL), true, `call ${i}`);
});
