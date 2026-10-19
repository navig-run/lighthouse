// The edge half of NAVIG OS over Lighthouse.
//
// Two kinds of test, both install-free:
//   * the pure rules in src/os_relay.ts (who is the uplink, when a browser is refused and
//     with which close code, the data-frame format);
//   * source guards on src/brain_socket.ts for the one property a unit test cannot reach
//     without a Durable Object runtime: that a browser socket is NEVER handled as the
//     brain's uplink. The uplink's `hello` replays the offline queue — Telegram webhooks,
//     secret-token headers included — down the socket that sent it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOSE,
  OS_CAP,
  OS_MAX_AUTHED,
  OS_MAX_PREAUTH,
  OS_MAX_PREAUTH_PER_IP,
  decideOpen,
  encodeData,
  parseDataFrame,
  sendableCloseCode,
  sendableCloseReason,
  sidFromTags,
  sidTag,
  socketRole,
  type OpenState,
} from '../src/os_relay.ts';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ready: OpenState = {
  retired: false,
  uplinkOpen: true,
  uplinkCaps: [OS_CAP],
  authed: 0,
  preauth: 0,
  preauthFromIp: 0,
};

test('a browser socket is never the uplink; an untagged legacy socket is', () => {
  assert.equal(socketRole(['os', sidTag(SID)]), 'os');
  assert.equal(socketRole(['uplink']), 'uplink');
  assert.equal(socketRole([]), 'uplink');
});

test('the stream id round-trips through tags and refuses anything that is not a uuid', () => {
  assert.equal(sidFromTags(['os', sidTag(SID)]), SID);
  assert.equal(sidFromTags(['os']), null);
  assert.equal(sidFromTags(['os', 'sid:../../etc']), null);
});

test('data frames: the edge slices the prefix and never touches the payload', () => {
  const payload = '{"type":"request","id":"1","data":"a:b@c"}';
  assert.deepEqual(parseDataFrame(encodeData(SID, payload)), { sid: SID, payload });
  // Control frames are JSON and must not be mistaken for data.
  assert.equal(parseDataFrame('{"t":"os_open","sid":"x"}'), null);
  assert.equal(parseDataFrame(`@not-a-sid:${payload}`), null);
  assert.equal(parseDataFrame('@'), null);
});

test('an OS connection is accepted only when everything is in place', () => {
  assert.deepEqual(decideOpen(ready), { accept: true });
});

test('each refusal carries the code the hosted app turns into a sentence', () => {
  const code = (s: Partial<OpenState>) => {
    const d = decideOpen({ ...ready, ...s });
    return d.accept ? 'accept' : d.code;
  };
  assert.equal(code({ retired: true }), CLOSE.RETIRED);
  assert.equal(code({ uplinkOpen: false }), CLOSE.OFFLINE);
  assert.equal(code({ uplinkCaps: [] }), CLOSE.UPDATE_NAVIG);
  assert.equal(code({ authed: OS_MAX_AUTHED }), CLOSE.LIMIT);
  assert.equal(code({ preauth: OS_MAX_PREAUTH }), CLOSE.LIMIT);
  assert.equal(code({ preauthFromIp: OS_MAX_PREAUTH_PER_IP }), CLOSE.LIMIT);
});

test('refusals are ordered by what the user can do about them', () => {
  // A retired relay needs a new pairing even if the computer is also offline.
  assert.equal((decideOpen({ ...ready, retired: true, uplinkOpen: false }) as { code: number }).code, CLOSE.RETIRED);
  // An offline computer must be woken before "update NAVIG" can mean anything.
  assert.equal((decideOpen({ ...ready, uplinkOpen: false, uplinkCaps: [] }) as { code: number }).code, CLOSE.OFFLINE);
});

test('a browser cannot make the DO send an illegal close', () => {
  for (const reserved of [1005, 1006, 1015, 999, 5000, Number.NaN, 'x']) {
    const c = sendableCloseCode(reserved);
    assert.ok(c === 1000 || c === 4000 || (c >= 3000 && c <= 4999), `${reserved} -> ${c}`);
  }
  assert.equal(sendableCloseCode(4401), 4401);
  assert.equal(sendableCloseCode(1009), 1009);
  assert.ok(new TextEncoder().encode(sendableCloseReason('é'.repeat(200))).length <= 123);
});

// ── Source guards on the Durable Object ─────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const DO_SRC = readFileSync(join(HERE, '..', 'src', 'brain_socket.ts'), 'utf8');

function methodBody(name: string): string {
  const start = DO_SRC.indexOf(`async ${name}(`);
  assert.ok(start >= 0, `${name} not found — did the handler get renamed?`);
  const next = DO_SRC.indexOf('\n  async ', start + 1);
  return DO_SRC.slice(start, next === -1 ? undefined : next);
}

test('webSocketMessage decides who sent a message before it parses a byte', () => {
  const body = methodBody('webSocketMessage');
  const roleCheck = body.indexOf('socketRole(');
  const parse = body.indexOf('JSON.parse');
  assert.ok(roleCheck >= 0 && parse >= 0);
  assert.ok(roleCheck < parse, 'the socket-role branch must come before JSON.parse');
});

test('closing a browser socket never fails the in-flight deck requests', () => {
  for (const name of ['webSocketClose', 'webSocketError']) {
    const body = methodBody(name);
    const roleCheck = body.indexOf('socketRole(');
    const fail = body.indexOf('failAllPending');
    assert.ok(roleCheck >= 0 && fail >= 0 && roleCheck < fail, `${name}: role branch before failAllPending`);
  }
});

test('the uplink lookup skips browser sockets', () => {
  const start = DO_SRC.indexOf('private liveSocket(');
  const body = DO_SRC.slice(start, DO_SRC.indexOf('\n  }', start));
  assert.match(body, /socketRole\(/);
});

test('the uplink is accepted tagged', () => {
  assert.match(DO_SRC, /acceptWebSocket\(server, \["uplink"\]\)/);
  assert.doesNotMatch(DO_SRC, /acceptWebSocket\(server\)/);
});
