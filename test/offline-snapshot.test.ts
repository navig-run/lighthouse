// Who may see the brain's cached status snapshot while the brain is offline.
//
// The snapshot is the operator's /api/deck/status: what is installed, what is running,
// when they were last online. It is fine for a caller that proved it holds the deck key
// (the Bearer routes) and wrong for anyone else. `/ingest/<tenant>/<source>` needs no key,
// and the tenant id is semi-public — it is in every webhook URL the operator hands out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DECK_PREFIXES, offlineSnapshotAllowed } from '../src/protocol.ts';

test('the key-authenticated deck routes keep the snapshot', () => {
  for (const p of ['/api/deck/status', '/runtime/x', '/mesh/peers']) {
    assert.equal(offlineSnapshotAllowed(p), true, p);
  }
});

test('keyless tenant-path routes never get it', () => {
  const tenant = 'a'.repeat(64);
  for (const p of [`/ingest/${tenant}/site`, `/os/${tenant}/pair`, `/os/${tenant}/connect`, `/os/${tenant}/api/deck/status`, '/', '/apix']) {
    assert.equal(offlineSnapshotAllowed(p), false, p);
  }
});

test('the allowed set is exactly the Bearer-routed prefixes', () => {
  // index.ts routes these three through viaBearer. Adding a prefix here without a Bearer
  // route in front of it would reopen the leak, so the two lists must move together.
  assert.deepEqual(DECK_PREFIXES, ['/api/', '/runtime/', '/mesh/']);
});
