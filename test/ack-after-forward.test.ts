// Telegram webhook deliveries are ACKed on hand-off, not on the brain's reply.
//
// The vision+agent pipeline routinely runs past the 30s REQUEST_TIMEOUT_MS, and
// a 504 makes Telegram RETRY the update mid-processing — the triple-OCR loop
// (2026-10-13). The brain's update_id dedup drops those replays, but the retry
// storm is still waste and delays real follow-ups: the edge must answer 200 the
// moment `ws.send` succeeds.
//
// Source-level (like routes-validate-tenant.test.ts), because a behavioural test
// would need the Workers runtime — a suite the gate would skip. `codeOnly()`
// blanks comments first so the explanatory prose can never satisfy an assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SOCKET = readFileSync(join(SRC, 'brain_socket.ts'), 'utf8');
const INDEX = readFileSync(join(SRC, 'index.ts'), 'utf8');

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const CODE = codeOnly(SOCKET);

/** The body of forward() from the telegram branch to the deck/sms Promise. */
function telegramBranch(): string {
  const start = CODE.indexOf('if (kind === "telegram")');
  assert.ok(start > -1, 'forward() must branch on kind === "telegram"');
  const rest = CODE.slice(start);
  const end = rest.indexOf('return new Promise<Response>');
  assert.ok(end > -1, 'the deck/sms pending path must still follow the branch');
  return rest.slice(0, end);
}

test('telegram is ACKed 200 right after ws.send, before any pending entry', () => {
  const branch = telegramBranch();
  assert.match(branch, /ws\.send\(/, 'the frame must actually be sent before the ACK');
  assert.match(branch, /status: 200/, 'the ACK must be a 2xx so Telegram stops retrying');
  assert.match(
    branch,
    /forwarded:\s*true/,
    'the ACK must be distinguishable from a brain-processed {ok:true}',
  );
  assert.ok(
    !branch.includes('this.pending.set'),
    'an early-ACKed delivery must not register a pending entry — a 30s timer ' +
      'would answer 504 AFTER Telegram already got 200',
  );
  assert.ok(
    !branch.includes('REQUEST_TIMEOUT_MS'),
    'telegram must not sit under the edge timeout at all',
  );
});

test('a failed uplink send still answers 502 so the provider keeps retrying', () => {
  const branch = telegramBranch();
  const catchIdx = branch.indexOf('catch');
  assert.ok(catchIdx > -1, 'ws.send must be guarded');
  const failIdx = branch.indexOf('uplink_send_failed');
  const okIdx = branch.indexOf('status: 200');
  assert.ok(failIdx > -1 && okIdx > -1, 'both paths must exist');
  assert.ok(
    failIdx < okIdx,
    'the failure return must precede the success ACK (early return, not fallthrough)',
  );
  // The failure path = from the catch to the success return's status line.
  const onFailure = branch.slice(catchIdx, okIdx);
  assert.match(onFailure, /uplink_send_failed/, 'send failure must keep its error body');
  assert.match(onFailure, /status: 502/, 'send failure must be a non-2xx');
  assert.ok(
    !/status:\s*200/.test(onFailure),
    'the 200 ACK must live on the success path only',
  );
});

test('a late brain res for an unknown id is dropped silently', () => {
  // The fire-and-forget precondition: without a pending entry the `res` that
  // arrives 60s after the ACK must be a no-op, not a throw.
  const resCase = CODE.slice(CODE.indexOf('case "res"'));
  assert.match(resCase, /this\.pending\.get\(/, 'res resolves through the pending map');
  assert.match(resCase, /if \(p\)/, 'an unknown id must be guarded before resolve');
});

test('the no-socket path still queues with 202, unchanged', () => {
  const branch = CODE.slice(CODE.indexOf('if (!ws)'));
  assert.match(branch, /this\.enqueue\(kind/, 'brain-asleep deliveries must be queued');
  assert.match(branch, /status: 202/, 'queued deliveries answer 202, not 200');
});

test('deck/sms keep the correlated pending path with the 30s 504', () => {
  const after = CODE.slice(CODE.indexOf('return new Promise<Response>'));
  assert.match(after, /this\.pending\.set\(/, 'deck/sms still await the brain reply');
  assert.match(after, /REQUEST_TIMEOUT_MS/, 'deck/sms keep the edge timeout');
  assert.match(after, /brain_timeout/, 'deck/sms keep the 504 body');
});

test('the lighthouse version was bumped for this delivery change', () => {
  // The delivery gate (scripts/check-lighthouse-delivery.mjs) refuses src
  // changes without a version bump; assert it here too so the failure is a
  // test, not only a gate.
  assert.match(INDEX, /LIGHTHOUSE_VERSION = "1\.[5-9]\.\d+"/);
});
