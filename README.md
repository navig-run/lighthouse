# 🗼 navig-lighthouse

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![CI](https://github.com/navig-run/lighthouse/actions/workflows/ci.yml/badge.svg)](https://github.com/navig-run/lighthouse/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

A self-hostable **Cloudflare edge** (Worker + Durable Object) that fronts one
[NAVIG](https://github.com/navig-run/core) brain over a single **outbound
WebSocket uplink**. The brain dials *out* and stays connected; Lighthouse pushes
inbound work (deck API, SSE, Telegram, SMS) down the pipe and reads replies back
— **no tunnels, no port-forwarding, no inbound ports.**

You deploy this to **your own** Cloudflare account. It holds **no NAVIG
secrets**: tenancy is keyed by `sha256(api_key)`, outbound traffic (bot replies,
SMS sends) stays direct from the brain, and the only stateful binding is one
Durable Object per brain.

```
                         ┌─────────────────────────── your Cloudflare account ──┐
  Telegram / SMS ──────► │  navig-lighthouse.<sub>.workers.dev                   │
  deck (browser) ──────► │     Worker (Hono)  ──►  BrainSocket (Durable Object)  │
                         └──────────────────────────────────▲───────────────────┘
                                                            │ outbound WS uplink
                                                            │ (the brain dials OUT)
                                                   ┌────────┴─────────┐
                                                   │   your NAVIG     │
                                                   │   brain (home)   │
                                                   └──────────────────┘
```

## Why

Exposing a home server to the internet usually means a tunnel daemon, a
port-forward, or a static IP. Lighthouse needs none of that: the brain opens one
**outbound** WebSocket to an edge Worker in *your* Cloudflare account and keeps
it warm. Everything inbound (Telegram webhooks, the deck UI/API, SSE, SMS) lands
on the Worker and is multiplexed down that single connection. The edge is
stateless-by-design and holds nothing sensitive.

## How it routes

| Public path | Auth | Goes to |
|---|---|---|
| `GET /uplink` | `Bearer <deck.api_key>` | brain establishes its uplink WebSocket |
| `GET /api/events` | `Bearer` | deck SSE stream (held open by the DO) |
| `ALL /api/*`, `/runtime/*`, `/mesh/*` | `Bearer` | deck API → forwarded down the uplink |
| `POST /tg/<hash>` | Telegram secret header | brain's Telegram webhook handler |
| `POST /sms/<hash>` | provider signature (brain-checked) | brain's inbound-SMS handler |
| `POST /ingest/<hash>/<source>` | per-source HMAC (brain-checked) | brain's Signals ingest |
| `GET /os/<hash>/connect` (WebSocket) | a paired **device token**, checked by the brain | NAVIG OS on the PC, streamed over the uplink (1.3.0+) |
| `POST /os/<hash>/pair` | a one-time pairing code, checked by the brain | exchanges the desktop's QR code for a device token |

`<hash>` is `sha256(api_key)` — the opaque per-brain path the brain set itself
via `setWebhook`. **The edge never holds the bot token.**

**Telegram deliveries are ACKed on hand-off (1.5.0+)**: `POST /tg/<hash>` answers
`200 {"ok": true, "forwarded": true}` the moment the frame is written to the
uplink — the brain's vision+agent pipeline routinely runs past the 30 s budget,
and a `504 brain_timeout` makes Telegram retry the update mid-processing. A send
failure still answers `502` (so a broken uplink keeps its retries) and a brain
that is asleep still answers `202 {"queued": true}` for replay. Deck/SMS keep
the correlated reply — they wait for the brain.

## NAVIG OS remote (1.3.0+)

A phone or browser at os.navig.run drives the NAVIG OS on your PC through this edge.
The PC dials out as always; nothing on it is exposed.

```
browser ⇄ wss /os/<hash>/connect ⇄ BrainSocket DO ⇄ (the brain's one uplink) ⇄ brain ⇄ NAVIG OS server
```

- **The edge authenticates nothing here.** It tags each browser socket `os` and relays its
  text under a stream id as `@<sid>:<payload>`. The brain checks the device token in the
  first message (NAVIG OS's own handshake) and swaps in the local server's token, which
  never leaves the PC. Devices are paired from the desktop (Settings → Remote access) and
  revoked there too; a revoke closes live sessions with 4401.
- **A browser socket can never act as the uplink.** Every message is classified by its
  socket's tag before it is parsed.
- **Close codes** the page turns into a sentence: `4503` computer offline, `4426` the brain
  predates the channel, `4410` NAVIG OS not running, `4401` device removed, `4404` relay
  retired (the deck key rotated: pair again), `4429` a limit, `1012` uplink restarted.

**Limits and cost.** Cloudflare does not bill Workers bandwidth. It bills messages *into* a
Durable Object (20 WebSocket messages = 1 request; the free plan includes 100k requests a
day) and the time a DO stays awake. So:

| Limit | Value | Why |
|---|---|---|
| Authenticated sessions per PC | 8 | a phone and a few browsers |
| Pending (unproven) sockets | 4 total, 2 per IP | the tenant id is semi-public |
| Browser → edge message | 1 MiB (close 1009) | bounds DO memory; the page fragments larger messages |
| Keepalive `{"t":"ka"}` | answered by the runtime | an idle phone never wakes the DO |
| Opening a session | counts against the per-tenant rate limit | a flood of opens cannot saturate the uplink |

The brain batches outgoing messages per session and meters them against a daily budget
(`os.remote.daily_msg_budget`, default 300,000 messages = 15,000 DO requests), refusing new
sessions with 4429 past it.

Measured 2026-09-30, a real phone session through a deployed edge to the installed desktop
app (30 min, 4 short chat turns): opening the app ≈ 700 messages (~1.1 MB), idle ≈ 12.5
messages/min — all browser → edge, the page's own polling; the brain sends nothing while idle —
and ≈ 60–75 per short chat turn. The keepalive never reaches the DO.
`scripts/os-channel-e2e.mjs` drives all of this against `wrangler dev`.

## Offline

While the brain is asleep the DO serves the **last snapshot** (cached in DO
SQLite) with `X-Navig-Brain: offline` for key-authenticated deck reads (keyless routes
get a bare `offline`, without the snapshot or last-online time), and **queues** inbound
Telegram/SMS for **replay** when the brain reconnects (bounded + TTL'd). Nothing
is lost.

## Requirements

- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account (the free
  Workers plan is enough — DO-SQLite buffering keeps it viable).
- For the manual path: **Node ≥ 18** and `wrangler` (installed via `npm install`).
- For the recommended path: just NAVIG — `navig lighthouse deploy` uploads a
  prebuilt bundle via the Cloudflare REST API, **no Node or wrangler required**.

## Deploy

The intended path is **`navig lighthouse deploy`** from
[navig-core](https://github.com/navig-run/core), which uploads a prebuilt bundle
of this Worker to your account via the Cloudflare REST API. Power users can build
and deploy directly:

```bash
npm install
npm run typecheck            # tsc --noEmit
npm run build:bundle         # wrangler deploy --dry-run --outdir dist (validates the build)
npx wrangler deploy          # → https://navig-lighthouse.<sub>.workers.dev
```

DO-SQLite buffering keeps this free-tier viable. Cloudflare Queues + DLQ are an
optional Workers-Paid hardening (commented in [`wrangler.jsonc`](./wrangler.jsonc)).

## Project layout

```
src/
  index.ts        Worker entrypoint (Hono router, auth, path → uplink fan-out)
  brain_socket.ts BrainSocket Durable Object — the per-brain uplink + replay queue
  protocol.ts     wire protocol shared between edge and brain
  os_relay.ts     NAVIG OS channel: socket roles, open/refuse rules, data-frame format
  tenant.ts       tenant id validation (no DO for a malformed id)
scripts/
  os-channel-e2e.mjs  end-to-end check of the OS channel against `wrangler dev`
  env.ts          typed Worker bindings
wrangler.jsonc    Cloudflare config (workers.dev, DO binding, migrations)
```

## Security

This Worker is designed to hold no secrets and to be safe to run on your own
account. If you find a vulnerability, please follow [SECURITY.md](./SECURITY.md)
— **do not** open a public issue for security reports.

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). The bar is: `npm run
typecheck` and `npm run build:bundle` both pass, and changes keep the edge
**secret-free**.

## License

[Apache-2.0](./LICENSE) © NAVIG.
