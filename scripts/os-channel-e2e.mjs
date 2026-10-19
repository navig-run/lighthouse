// End-to-end check of the NAVIG OS channel against the REAL Durable Object runtime.
//
// The unit tests (test/os-relay.test.ts) cover the pure rules; this covers what only the
// runtime can prove: socket tags and attachments, accept-then-close codes reaching the
// browser, the keepalive auto-response, the per-IP and total pre-auth caps, retire, and
// that deck requests keep flowing while OS streams are open. It plays both the brain
// (a fake uplink) and the phones.
//
//   npx wrangler dev --port 8799 --ip 127.0.0.1      # in services/lighthouse
//   node scripts/os-channel-e2e.mjs 8799
//
// Needs `ws` (a wrangler dependency) because Node's built-in WebSocket cannot set the
// uplink's Authorization header. Exits 1 on any failure.
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

const port = process.argv[2] ?? '8799';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const base = `127.0.0.1:${port}`;
const key = 'navig_' + randomBytes(24).toString('hex');
const tenant = createHash('sha256').update(key).digest('hex');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(url, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    const msgs = [];
    let closed = null;
    ws.on('message', (d) => msgs.push(d.toString()));
    ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    ws.once('open', () => resolve({ ws, msgs, get closed() { return closed; } }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, msgs, status: res.statusCode, get closed() { return closed; } }));
    setTimeout(() => resolve({ ws, msgs, get closed() { return closed; } }), 5000);
  });
}
const browser = (ip = '') => open(`ws://${base}/os/${tenant}/connect`, { headers: { 'User-Agent': 'e2e-phone', Origin: 'https://os.navig.run', ...(ip ? { 'CF-Connecting-IP': ip } : {}) } });

// 1. No uplink yet → 4503 offline.
let b = await browser(); await sleep(500);
check('no uplink: browser gets 4503 with a reason', b.closed?.code === 4503, JSON.stringify(b.closed));

// 2. Uplink WITHOUT caps (an old brain) → 4426.
let up = await open(`ws://${base}/uplink`, { headers: { Authorization: `Bearer ${key}` } });
up.ws.send(JSON.stringify({ t: 'hello' })); await sleep(300);
b = await browser(); await sleep(500);
check('old brain (no caps): 4426 update NAVIG', b.closed?.code === 4426, JSON.stringify(b.closed));

// 3. Brain declares caps → accepted; os_open reaches the brain with a sid.
up.ws.send(JSON.stringify({ t: 'hello', caps: ['os1'] })); await sleep(300);
b = await browser(); await sleep(500);
const openFrame = up.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).find((f) => f?.t === 'os_open');
check('caps present: socket accepted and os_open sent to the brain', !b.closed && !!openFrame?.sid, JSON.stringify(openFrame));
const sid = openFrame?.sid;
check('os_open carries the user agent hint', openFrame?.ua === 'e2e-phone');

// 4. Browser → brain data is prefixed with the sid, payload untouched.
const hs = '{"type":"handshake","id":"h1","token":"device-token-xyz"}';
b.ws.send(hs); await sleep(300);
check('browser message reaches the brain as @sid:payload', up.msgs.includes(`@${sid}:${hs}`));

// 5. Brain → browser data arrives verbatim.
up.ws.send(`@${sid}:{"type":"handshake_ack","clientId":"c1"}\n{"type":"event","seq":1}`); await sleep(300);
check('brain data reaches the browser verbatim (batch included)', b.msgs.includes('{"type":"handshake_ack","clientId":"c1"}\n{"type":"event","seq":1}'), JSON.stringify(b.msgs));

// 6. Keepalive is answered without the brain seeing it.
const before = up.msgs.length;
b.ws.send('{"t":"ka"}'); await sleep(300);
check('keepalive answered by the edge', b.msgs.includes('{"t":"ka"}'));
check('keepalive never reaches the brain', up.msgs.length === before);

// 7. A browser pretending to be the uplink gets nothing it should not.
b.ws.send(JSON.stringify({ t: 'hello', caps: ['os1'] })); await sleep(300);
check('a fake hello from a browser is relayed as data, not obeyed', up.msgs.at(-1) === `@${sid}:${JSON.stringify({ t: 'hello', caps: ['os1'] })}`);

// 8. Oversized browser message → 1009.
const b2 = await browser(); await sleep(300);
b2.ws.send('x'.repeat(1024 * 1024 + 10)); await sleep(800);
check('oversized browser message closes 1009', b2.closed?.code === 1009, JSON.stringify(b2.closed));

// 9. Brain closes a stream with a code → browser sees it.
up.ws.send(JSON.stringify({ t: 'os_close', sid, code: 4401, reason: 'device revoked' })); await sleep(500);
check('brain os_close reaches the browser with code and reason', b.closed?.code === 4401 && b.closed?.reason === 'device revoked', JSON.stringify(b.closed));

// 10. Browser leaving tells the brain, and does not fail the uplink.
const b3 = await browser(); await sleep(300);
const sid3 = up.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter((f) => f?.t === 'os_open').at(-1)?.sid;
b3.ws.close(1000, 'bye'); await sleep(500);
const closeFrame = up.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).find((f) => f?.t === 'os_close' && f.sid === sid3);
check('browser close is reported to the brain', !!closeFrame, JSON.stringify(closeFrame));
check('uplink survives a browser leaving', !up.closed);

// 11. Pre-auth cap per IP.
const pend = [await browser('203.0.113.7'), await browser('203.0.113.7'), await browser('203.0.113.7')]; await sleep(500);
check('third pending socket from one IP is refused 4429', pend.filter((p) => p.closed?.code === 4429).length === 1, JSON.stringify(pend.map((p) => p.closed)));
for (const p of pend) try { p.ws.close(); } catch {}
await sleep(500);
const many = []; for (let i = 0; i < 6; i++) many.push(await browser(`198.51.100.${i}`)); await sleep(500);
check('pending sockets across IPs are capped at 4', many.filter((p) => p.closed?.code === 4429).length === 2, JSON.stringify(many.map((p) => p.closed?.code ?? 'open')));
for (const p of many) try { p.ws.close(); } catch {}
await sleep(500);

// 12. Deck request still round-trips while OS streams exist.
const res = fetch(`http://${base}/api/deck/status`, { headers: { Authorization: `Bearer ${key}` } });
await sleep(300);
const req = up.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).find((f) => f?.t === 'req');
up.ws.send(JSON.stringify({ t: 'res', id: req?.id, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }));
const r = await res;
check('deck request still answered alongside OS streams', r.status === 200 && (await r.text()) === '{"ok":true}');

// 13. Retire → subsequent connects 4404.
up.ws.send(JSON.stringify({ t: 'retire' })); await sleep(300);
b = await browser(); await sleep(500);
check('after retire, connects get 4404 pair again', b.closed?.code === 4404, JSON.stringify(b.closed));

// 14. A keyless pair POST while... (brain online) is forwarded as a deck req.
const pr = fetch(`http://${base}/os/${tenant}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"x"}' });
await sleep(300);
const preq = up.msgs.map((m) => { try { return JSON.parse(m); } catch { return null; } }).filter((f) => f?.t === 'req').at(-1);
check('pair POST forwarded to the brain with its public path', preq?.path === `/os/${tenant}/pair` && preq?.kind === 'deck', JSON.stringify(preq && { path: preq.path, kind: preq.kind }));
up.ws.send(JSON.stringify({ t: 'res', id: preq?.id, status: 404, headers: {}, body: '{}' }));
await pr;

// 15. Uplink goes away → offline pair POST gets no snapshot.
up.ws.close(); await sleep(500);
const off = await fetch(`http://${base}/os/${tenant}/pair`, { method: 'POST', body: '{}' });
const offBody = await off.json();
check('offline pair POST: 503 with no snapshot and no last-online time', off.status === 503 && offBody.snapshot === null && offBody.since === null, JSON.stringify(offBody));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed · ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
