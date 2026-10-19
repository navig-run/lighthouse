// Every route that turns a PUBLIC path segment into a Durable Object must
// validate it first.
//
// `tenant.test.ts` proves the validator works; this proves it is actually
// wired. `env.BRAIN.idFromName(x)` makes every distinct string a distinct DO, so
// one unvalidated route re-opens the whole hole — an attacker loops random paths
// and instantiates unbounded Durable Objects on the user's own Cloudflare
// account. The DO's per-tenant rate limit cannot help: it lives *inside* a DO,
// so each bogus tenant gets a fresh, full token bucket.
//
// Source-level, because a route test would need `hono` — and a suite that needs
// an install is a suite the gate skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const INDEX = readFileSync(join(SRC, 'index.ts'), 'utf8');

/** Blank comments (preserving line count) so prose describing the rule is not
 *  reported as breaking it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const CODE = codeOnly(INDEX);

test('no route reaches brainFor() with a raw path parameter', async () => {
  const offenders: string[] = [];
  CODE.split('\n').forEach((line, i) => {
    if (/brainFor\s*\([^)]*c\.req\.param\s*\(/.test(line)) {
      offenders.push(`src/index.ts:${i + 1}  ${line.trim()}`);
    }
  });

  assert.deepEqual(
    offenders,
    [],
    'A public path segment must go through viaTenantPath (which calls isTenantId) ' +
      'before any Durable Object is addressed:\n' + offenders.join('\n'),
  );
});

test('every public tenant route is routed through the validating helper', async () => {
  // Enumerated from the source rather than hardcoded, so a NEW `/x/:tenant`
  // route is covered the day it is written.
  const routes = [...CODE.matchAll(/app\.(get|post|all)\(\s*["'`](\/[^"'`]*:tenant[^"'`]*)["'`]/g)];
  assert.ok(routes.length >= 3, `expected the tg/sms/ingest routes, found ${routes.length}`);

  for (const [, , path] of routes) {
    // The handler body is on the same or the next few lines; take a window.
    const at = CODE.indexOf(path);
    const window = CODE.slice(at, at + 400);
    assert.match(
      window,
      /viaTenantPath\(/,
      `route ${path} must call viaTenantPath before addressing a brain`,
    );
  }
});

test('the validating helper actually checks the shape', async () => {
  // Anti-vacuity partner: routing everything through a helper that validates
  // nothing would satisfy the two tests above and fix nothing.
  assert.match(CODE, /function viaTenantPath\(/);
  const helper = CODE.slice(CODE.indexOf('function viaTenantPath('));
  assert.match(helper.slice(0, 600), /isTenantId\(/, 'viaTenantPath must call isTenantId');
});

test('the guard reads code, not the comments that describe it', async () => {
  const withProse = codeOnly(`
    // brainFor(c.env, c.req.param("tenant")) was the bug
    /* app.post("/x/:tenant", ...) */
    const real = 1;
  `);
  assert.ok(!/brainFor/.test(withProse), 'line comments must be blanked');
  assert.ok(!/app\.post/.test(withProse), 'block comments must be blanked');
  assert.ok(withProse.includes('const real = 1;'), 'code must survive');
  assert.equal(withProse.split('\n').length, 5, 'line numbers must be preserved');
});
