/// <reference types="@cloudflare/workers-types" />
/**
 * Lighthouse — a self-hosted Cloudflare edge that fronts one navig brain over
 * a single OUTBOUND WebSocket uplink. The brain dials out and stays connected;
 * Lighthouse pushes inbound work (deck API, SSE, Telegram, SMS) down the pipe
 * and reads replies back. No tunnels, no port-forwarding — ever.
 *
 * The user deploys this Worker to THEIR own Cloudflare account (see
 * `navig lighthouse deploy`), so it holds no navig secrets. Tenancy is keyed
 * by sha256(api_key): the brain authenticates the uplink with its deck api_key,
 * the deck calls with the same key as a Bearer, and inbound webhooks address an
 * opaque per-brain path (`/tg/<hash>`, `/sms/<hash>`) the brain set itself.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { BrainSocket } from "./brain_socket";
import type { Env } from "./env";
import { isTenantId, sha256Hex } from "./tenant";

export { BrainSocket };

// Bumped whenever the Worker changes. Exposed at `GET /` so `navig lighthouse
// status` can compare the DEPLOYED edge against the version bundled in this
// navig release and tell you whether to `navig lighthouse redeploy`.
// 1.1.0 — public webhook paths are validated as tenant ids before any Durable
// Object is addressed. This bump is load-bearing, not cosmetic: `navig
// lighthouse status` compares this string against the live edge's `GET /`, so
// leaving it at 1.0.0 would report every already-deployed edge as up to date and
// no user would ever redeploy to pick the fix up.
// 1.2.0 - CORS: allow X-Telegram-User and the write methods the deck actually
// uses. Also load-bearing: without a bump, every already-deployed edge keeps
// answering preflights with the old list and the Mini App stays broken.
// 1.2.1 - an offline brain's status snapshot is only served on key-authenticated routes.
// 1.3.0 - NAVIG OS channel: /os/:tenant/connect (a phone or browser drives the PC's NAVIG
// OS through the uplink) and /os/:tenant/pair. The desktop reads this version before it
// offers pairing, so an edge without the channel says "update relay" instead of a QR code
// that leads nowhere.
// 1.4.0 - brain link: /os/:tenant/api/deck/* carries the deck calls of ANOTHER NAVIG OS
// that uses this brain. The brain refuses `navig os link` against an older edge.
// 1.5.0 - Telegram is ACKed on hand-off, not on the brain's reply.
// 1.6.0 - dependency hardening: hono 4.13.13 (the advisory through 4.13.6), current
// wrangler/workers-types, and a lockfile that audits clean. No route changes — redeploy so the
// edge runs the patched runtime.
const LIGHTHOUSE_VERSION = "1.6.0";

const app = new Hono<{ Bindings: Env }>();

// The deck is a browser app served from some other origin (relay.navig.run, a
// custom domain, or the user's own host). It authenticates with a Bearer key,
// not cookies, so reflecting the Origin is safe.
//
// This edge is a TRANSPARENT PROXY to the daemon's deck API, so this list must
// mirror what the daemon itself accepts (navig/gateway/middleware.py), not some
// smaller subset. It did not, and a preflight the edge answers with a shorter
// list is a request the browser never sends -- it surfaces in the deck as
// `TypeError: Failed to fetch`, indistinguishable from the edge being down.
//
// Two entries were missing, both measured against the live edge:
//   X-Telegram-User -- sent by apps/deck `authHeaders()` for EVERY request, but
//     ONLY when Telegram initData is present. So a browser worked and the Mini
//     App -- the whole point of lighthouse mode -- could not load at all, which
//     is exactly how it was reported ("deck telegram doesn't work"). The daemon
//     reads this header (gateway/deck/auth.py) and all three sibling CORS lists
//     already allowed it; this copy was the outlier.
//   DELETE/PUT/PATCH -- the deck issues DELETE from 10 call sites (vault
//     credentials, connectors, MCP servers...). Every one failed its preflight
//     through an edge.
// tests/cors_parity.test.ts pins this list against the daemon's so the four
// hand-maintained copies cannot drift apart again.
app.use(
  "*",
  cors({
    origin: (o) => o || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "X-Telegram-Init-Data",
      "X-Telegram-User",
    ],
    maxAge: 86400,
  }),
);

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const m = (c.req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function brainFor(env: Env, hashHex: string): DurableObjectStub {
  return env.BRAIN.get(env.BRAIN.idFromName(hashHex));
}

/** Route an unauthenticated webhook to its brain, or refuse before any Durable
 *  Object exists. `idFromName` makes every distinct string a distinct DO, so an
 *  unvalidated public path segment is an unbounded-DO-spawn vector against the
 *  user's own Cloudflare account — see `tenant.ts`. Returns 404, the same answer
 *  an unknown tenant already got, so nothing about which brains exist leaks. */
function viaTenantPath(
  c: { req: { raw: Request; param: (k: string) => string }; env: Env },
  tenant: string,
  internalPath?: string,
): Response | Promise<Response> {
  if (!isTenantId(tenant)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const req = internalPath ? new Request(`https://brain${internalPath}`, c.req.raw) : c.req.raw;
  return brainFor(c.env, tenant).fetch(req);
}

/** Bearer-authenticated routes derive the tenant from the key itself. */
async function viaBearer(
  c: { req: { raw: Request; header: (k: string) => string | undefined }; env: Env },
  internalPath?: string,
): Promise<Response> {
  const key = bearer(c);
  if (!key) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const hash = await sha256Hex(key);
  const req = internalPath
    ? new Request(`https://brain${internalPath}`, c.req.raw)
    : c.req.raw;
  return brainFor(c.env, hash).fetch(req);
}

// ── Uplink: the brain establishes its outbound WebSocket here ────────────────
app.get("/uplink", (c) => viaBearer(c, "/__uplink"));

// ── Deck SSE: held open by the DO; the brain pushes events up the uplink ─────
// EventSource can't send an Authorization header, so the tenant key arrives as
// a `?key=` query param (the daemon exempts /api/events from auth for the same
// reason). Bearer is still accepted as a fallback for non-browser clients.
app.get("/api/events", async (c) => {
  const key = c.req.query("key") || bearer(c);
  if (!key) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const hash = await sha256Hex(key);
  return brainFor(c.env, hash).fetch(new Request("https://brain/__events", c.req.raw));
});

// ── Deck API surface: forwarded verbatim down the uplink (kind=deck) ─────────
app.all("/api/*", (c) => viaBearer(c));
app.all("/runtime/*", (c) => viaBearer(c));
app.all("/mesh/*", (c) => viaBearer(c));

// ── Telegram webhook: opaque per-brain path; the brain validates the secret ──
app.post("/tg/:tenant", (c) => {
  // Cheap anti-noise filter; the brain does the real secret-token check.
  if (!c.req.header("X-Telegram-Bot-Api-Secret-Token")) {
    return c.json({ error: "forbidden" }, 403);
  }
  return viaTenantPath(c, c.req.param("tenant"));
});

// ── Inbound SMS (Twilio etc.): the brain validates the provider signature ────
app.post("/sms/:tenant", (c) => viaTenantPath(c, c.req.param("tenant")));

// ── Inbound Signals ingest: opaque per-brain path; the brain validates the ───
// per-source HMAC. Like /tg and /sms, the public caller (the user's website)
// holds no deck key — the tenant segment only routes to the right brain. The DO
// forwards this verbatim as kind=deck; the brain rewrites it to /api/ingest/<source>.
app.post("/ingest/:tenant/:source", (c) => viaTenantPath(c, c.req.param("tenant")));

// ── NAVIG OS: a paired phone/browser drives the PC's NAVIG OS through the uplink ──
// Keyless like /tg and /ingest: the tenant segment only routes. The DO accepts the
// socket; the BRAIN authenticates the device from the first message (a device token,
// never in the URL — URLs are logged). See os_relay.ts.
app.get("/os/:tenant/connect", (c) => {
  const tenant = c.req.param("tenant");
  return viaTenantPath(c, tenant, "/__os");
});

// Redeem a one-time pairing code (from the desktop's QR) for a device token. Forwarded
// verbatim as kind=deck; the brain rewrites it to its public redeem route, where the code
// itself is the credential (128-bit, single use, 2 minutes).
app.post("/os/:tenant/pair", (c) => viaTenantPath(c, c.req.param("tenant")));

// Brain link: a NAVIG OS on another machine uses this brain's deck API. The tenant only
// routes (the caller's credential is its own revocable device token, never the deck key,
// so it cannot route by key hash like /api/*). Forwarded verbatim as kind=deck; the brain
// rewrites it to /api/deck/<rest> only when a Bearer is present, and deck auth checks it.
// Never served the offline snapshot: offlineSnapshotAllowed() does not match /os/.
app.all("/os/:tenant/api/deck/*", (c) => viaTenantPath(c, c.req.param("tenant")));

// ── Service root + 404 ───────────────────────────────────────────────────────
app.get("/", (c) => c.json({ ok: true, service: "navig-lighthouse", version: LIGHTHOUSE_VERSION }));
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
