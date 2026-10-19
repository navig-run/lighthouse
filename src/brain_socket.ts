/// <reference types="@cloudflare/workers-types" />
/**
 * BrainSocket — one Durable Object per brain (named by sha256(api_key)).
 *
 * It is the single rendezvous point between the public edge and one navig
 * brain:
 *   • holds the brain's outbound WebSocket uplink (WebSocket Hibernation, so
 *     an idle brain costs nothing while staying "always-on");
 *   • correlates forwarded inbound requests (deck API, Telegram, SMS) to the
 *     replies the brain sends back;
 *   • fans server-sent events the brain pushes up out to attached SSE clients;
 *   • caches the brain's latest snapshot + queues inbound work in DO SQLite so
 *     nothing is lost while the brain is asleep, replaying on reconnect.
 *
 * Hibernation note: the in-memory `pending`/`sse` maps are lost if the DO is
 * evicted. That's safe because (a) a forwarded request lives inside an open
 * `fetch()` whose promise keeps the DO resident until the reply arrives, and
 * (b) an open SSE response stream likewise pins the DO. Eviction only happens
 * when nothing is in flight, at which point there is nothing to lose.
 */

import type { Env } from "./env";
import {
  CLOSE,
  KEEPALIVE,
  OS_MAX_INBOUND_BYTES,
  decideOpen,
  encodeData,
  parseDataFrame,
  sendableCloseCode,
  sendableCloseReason,
  sidFromTags,
  sidTag,
  socketRole,
} from "./os_relay";
import { offlineSnapshotAllowed, type ReqFrame, type UpFrame } from "./protocol";

/** What the DO remembers on each hibernatable socket (survives hibernation, <= 2 KiB). */
interface UplinkAttachment {
  caps: string[];
}
interface OsAttachment {
  authed: boolean;
  ip: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_QUEUE = 500; // bounded inbound backlog while the brain is offline
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // drop replays older than a day

// Per-tenant rate limit (DoS blunting). The DO is the per-tenant boundary (one
// instance per brain), so an in-memory token bucket here caps a single brain's
// inbound request rate with no cross-tenant coordination. Best-effort: buckets
// reset on hibernation/eviction — fine, the goal is to blunt floods, not to
// meter exactly. SSE and the uplink are long-lived and never counted; provider
// webhooks (telegram/sms) are left to their own edge filter + the brain's
// signature checks. Defaults are generous so real interactive/deck use (which
// polls) never trips; a flood is orders of magnitude higher.
const DEFAULT_RATE_LIMIT_PER_MIN = 600; // sustained ~10 req/s per brain
const RATE_BURST = 200; // bucket capacity (instantaneous burst, e.g. page-load fan-out)

interface Pending {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrainSocket implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;
  private pending = new Map<string, Pending>();
  private sse = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private heartbeats = new Map<WritableStreamDefaultWriter<Uint8Array>, ReturnType<typeof setInterval>>();
  private encoder = new TextEncoder();
  // Token bucket for the per-tenant rate limit (see constants above).
  private rateTokens = RATE_BURST;
  private rateRefillAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS queue (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT NOT NULL,
         path TEXT NOT NULL,
         headers TEXT NOT NULL,
         body TEXT NOT NULL,
         created INTEGER NOT NULL
       );`,
    );
    // The hosted OS adapter's keepalive is answered by the runtime itself, so an idle
    // remote session never wakes the DO (a woken DO bills duration; this one would wake
    // twice a minute per phone). Nothing else ever sends this exact string.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE, KEEPALIVE));
  }

  // ── HTTP surface (called by the Worker via the DO stub) ────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1) Brain dials in to establish the uplink.
    if (url.pathname === "/__uplink") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Single-live-uplink invariant (R9 H1): evict any prior uplink so a second
      // authenticated dial-in can't hijack this tenant's replies/SSE. The brain
      // only ever opens one uplink and its reconnect loop handles being closed.
      // Remote OS sessions ride the old uplink, so they end with it; their clients
      // reconnect (1012) and land on the new one.
      for (const prev of this.state.getWebSockets()) {
        try { prev.close(CLOSE.UPLINK_RESTART, "superseded"); } catch { /* already closing */ }
      }
      // Hibernatable accept — survives idle without burning duration billing. Tagged, so
      // no other socket in this DO can ever be taken for it (see os_relay.socketRole).
      this.state.acceptWebSocket(server, ["uplink"]);
      server.serializeAttachment({ caps: [] } satisfies UplinkAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 1b) A phone or browser opening a NAVIG OS session (index.ts /os/:tenant/connect).
    if (url.pathname === "/__os") {
      return this.openOs(request);
    }

    // 2) Deck SSE stream — held open here; the brain pushes events up the uplink.
    if (url.pathname === "/__events") {
      return this.openSse();
    }

    // 3) Anything else is an inbound request to forward to the brain. The kind
    //    is inferred from the path so the public route alone decides routing.
    const kind: ReqFrame["kind"] = url.pathname.startsWith("/tg/")
      ? "telegram"
      : url.pathname.startsWith("/sms/")
        ? "sms"
        : "deck";

    // Per-tenant rate limit — runs before forward()/enqueue() so a flood can
    // neither saturate the uplink nor fill the offline queue. 429 with Retry-After
    // is the standard "slow down" signal (providers/browsers honor it).
    if (this.rateLimited()) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    }
    return this.forward(request, kind);
  }

  /** True when this tenant has exceeded its inbound request budget. */
  private rateLimited(): boolean {
    const perMin = Number(this.env.RATE_LIMIT_PER_MIN ?? DEFAULT_RATE_LIMIT_PER_MIN);
    if (!Number.isFinite(perMin) || perMin <= 0) return false; // disabled / misconfigured
    const now = Date.now();
    if (this.rateRefillAt === 0) this.rateRefillAt = now;
    const elapsed = now - this.rateRefillAt;
    if (elapsed > 0) {
      this.rateTokens = Math.min(RATE_BURST, this.rateTokens + (elapsed / 60_000) * perMin);
      this.rateRefillAt = now;
    }
    if (this.rateTokens < 1) return true;
    this.rateTokens -= 1;
    return false;
  }

  // ── WebSocket Hibernation handlers ─────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // WHO sent this decides everything, and it is decided before any byte is parsed. A
    // browser socket that could speak uplink frames could replay the offline queue
    // (Telegram webhooks, secret headers included) to itself with a fake `hello`.
    if (socketRole(this.state.getTags(ws)) === "os") {
      this.fromBrowser(ws, message);
      return;
    }
    if (typeof message === "string") {
      const data = parseDataFrame(message);
      if (data) {
        this.toBrowser(data.sid, data.payload);
        return;
      }
    }
    let frame: UpFrame;
    try {
      frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    switch (frame.t) {
      case "res": {
        const p = this.pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.id);
          p.resolve(
            new Response(frame.body, {
              status: frame.status,
              headers: frame.headers,
            }),
          );
        }
        return;
      }
      case "event":
        this.fanout(frame.event, frame.data);
        return;
      case "snapshot":
        this.sql.exec(
          "INSERT INTO kv (k, v) VALUES ('snapshot', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          frame.data,
        );
        this.sql.exec(
          "INSERT INTO kv (k, v) VALUES ('snapshot_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
          String(Date.now()),
        );
        return;
      case "hello":
        if (frame.snapshot) {
          this.sql.exec(
            "INSERT INTO kv (k, v) VALUES ('snapshot', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            frame.snapshot,
          );
        }
        // What this brain can do, kept on its socket so it survives hibernation.
        ws.serializeAttachment({
          caps: Array.isArray(frame.caps)
            ? frame.caps.filter((c) => typeof c === "string").slice(0, 16)
            : [],
        } satisfies UplinkAttachment);
        // The brain is (re)connected — flush anything we buffered while it slept.
        await this.replayQueue(ws);
        return;
      case "pong":
        return;
      case "os_ok": {
        const sock = this.osSocket(frame.sid);
        const att = sock?.deserializeAttachment() as OsAttachment | null;
        if (sock && att) sock.serializeAttachment({ ...att, authed: true } satisfies OsAttachment);
        return;
      }
      case "os_close": {
        const sock = this.osSocket(frame.sid);
        if (sock) this.closeQuietly(sock, frame.code, frame.reason ?? "");
        return;
      }
      case "retire":
        this.sql.exec(
          "INSERT INTO kv (k, v) VALUES ('retired', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        );
        this.closeAllOs(CLOSE.RETIRED, "relay moved: pair again");
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    if (socketRole(this.state.getTags(ws)) === "os") {
      // A browser left. Only its own stream ends, not the deck requests in flight.
      this.tellBrainClosed(ws, code, reason);
      return;
    }
    this.failAllPending();
    this.closeAllOs(CLOSE.UPLINK_RESTART, "computer reconnecting");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (socketRole(this.state.getTags(ws)) === "os") {
      this.tellBrainClosed(ws, 1011, "browser socket error");
      return;
    }
    this.failAllPending();
    this.closeAllOs(CLOSE.UPLINK_RESTART, "computer reconnecting");
  }

  // ── NAVIG OS channel ───────────────────────────────────────────────────────

  private openOs(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const ip = request.headers.get("cf-connecting-ip") ?? "";
    const uplink = this.liveSocket();
    const caps = (uplink?.deserializeAttachment() as UplinkAttachment | null)?.caps ?? [];
    let authed = 0;
    let preauth = 0;
    let preauthFromIp = 0;
    for (const sock of this.state.getWebSockets("os")) {
      const att = sock.deserializeAttachment() as OsAttachment | null;
      if (att?.authed) authed++;
      else {
        preauth++;
        if (ip && att?.ip === ip) preauthFromIp++;
      }
    }
    const retired = this.sql.exec("SELECT v FROM kv WHERE k = 'retired'").toArray().length > 0;
    let decision = decideOpen({ retired, uplinkOpen: !!uplink, uplinkCaps: caps, authed, preauth, preauthFromIp });
    // Counted against the same per-tenant budget as forwarded requests, so a flood of
    // opens cannot saturate the uplink with os_open frames.
    if (decision.accept && this.rateLimited()) {
      decision = { accept: false, code: CLOSE.LIMIT, reason: "rate limited" };
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    if (!decision.accept || !uplink) {
      // Accept-then-close is the only way page script learns WHY: a refused upgrade
      // reaches it as a bare 1006 with no reason at all.
      server.accept();
      const code = decision.accept ? CLOSE.OFFLINE : decision.code;
      const reason = decision.accept ? "computer offline" : decision.reason;
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    }

    const sid = crypto.randomUUID();
    this.state.acceptWebSocket(server, ["os", sidTag(sid)]);
    server.serializeAttachment({ authed: false, ip } satisfies OsAttachment);
    try {
      uplink.send(
        JSON.stringify({
          t: "os_open",
          sid,
          ua: (request.headers.get("user-agent") ?? "").slice(0, 200),
          ip,
          country: request.headers.get("cf-ipcountry") ?? "",
        }),
      );
    } catch {
      server.close(CLOSE.OFFLINE, "computer offline");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A browser message: hand it to the brain verbatim under its stream id. */
  private fromBrowser(ws: WebSocket, message: string | ArrayBuffer): void {
    const sid = sidFromTags(this.state.getTags(ws));
    if (!sid) return this.closeQuietly(ws, 1011, "untracked socket");
    if (typeof message !== "string") {
      return this.closeQuietly(ws, CLOSE.UNSUPPORTED, "text frames only");
    }
    if (message.length > OS_MAX_INBOUND_BYTES) {
      this.closeQuietly(ws, CLOSE.TOO_BIG, "message too big");
      this.tellBrainClosed(ws, CLOSE.TOO_BIG, "message too big");
      return;
    }
    const uplink = this.liveSocket();
    if (!uplink) return this.closeQuietly(ws, CLOSE.OFFLINE, "computer offline");
    try {
      uplink.send(encodeData(sid, message));
    } catch {
      this.closeQuietly(ws, CLOSE.OFFLINE, "computer offline");
    }
  }

  /** A brain message for one stream: deliver it as-is (sends from a DO are not billed). */
  private toBrowser(sid: string, payload: string): void {
    const sock = this.osSocket(sid);
    if (!sock) {
      // The browser is already gone; tell the brain so it stops sending.
      try {
        this.liveSocket()?.send(JSON.stringify({ t: "os_close", sid, code: 1001, reason: "browser gone" }));
      } catch {
        /* the uplink is going too */
      }
      return;
    }
    try {
      sock.send(payload);
    } catch {
      this.tellBrainClosed(sock, 1011, "send to browser failed");
    }
  }

  private osSocket(sid: string): WebSocket | null {
    for (const sock of this.state.getWebSockets(sidTag(sid))) {
      if (sock.readyState === WebSocket.READY_STATE_OPEN) return sock;
    }
    return null;
  }

  private tellBrainClosed(ws: WebSocket, code: number, reason: string): void {
    const sid = sidFromTags(this.state.getTags(ws));
    const uplink = this.liveSocket();
    if (!sid || !uplink) return;
    try {
      uplink.send(JSON.stringify({ t: "os_close", sid, code, reason: sendableCloseReason(reason) }));
    } catch {
      /* the uplink is going too; the brain tears every stream down with it */
    }
  }

  private closeAllOs(code: number, reason: string): void {
    for (const sock of this.state.getWebSockets("os")) this.closeQuietly(sock, code, reason);
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(sendableCloseCode(code), sendableCloseReason(reason));
    } catch {
      /* already closing */
    }
  }

  // ── Forwarding ─────────────────────────────────────────────────────────────

  /** The brain's uplink — never a browser socket, whatever order they were accepted in. */
  private liveSocket(): WebSocket | null {
    for (const ws of this.state.getWebSockets()) {
      if (socketRole(this.state.getTags(ws)) !== "uplink") continue;
      if (ws.readyState === WebSocket.READY_STATE_OPEN) return ws;
    }
    return null;
  }

  private async forward(request: Request, kind: ReqFrame["kind"]): Promise<Response> {
    const ws = this.liveSocket();
    const url = new URL(request.url);
    // Never forward/persist the deck api_key (R9 M2): SSE passes it as ?key= since
    // EventSource can't set headers; the brain is already tenant-routed, so strip it
    // before it lands in the brain's request path / the offline queue / logs.
    url.searchParams.delete("key");
    const path = url.pathname + url.search;
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      // Hop-by-hop / edge-only headers the brain shouldn't see.
      if (k === "host" || k === "connection" || k === "upgrade") return;
      headers[k] = v;
    });
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();

    if (!ws) {
      // Brain asleep. Deck reads get the cached snapshot + an offline banner;
      // webhook deliveries (Telegram/SMS) are queued for replay and ack'd now
      // so the provider doesn't retry-storm.
      if (kind === "deck") return this.offlineResponse(offlineSnapshotAllowed(url.pathname));
      this.enqueue(kind, path, headers, body);
      return new Response(JSON.stringify({ queued: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    const id = crypto.randomUUID();
    const frame: ReqFrame = { t: "req", id, kind, method: request.method, path, headers, body };

    // Telegram deliveries are ACKed on HAND-OFF, not on the brain's reply: the
    // vision+agent pipeline routinely exceeds the 30s budget, and a 504 makes
    // Telegram RETRY the update while the first one is still processing (the
    // triple-OCR loop; update_id dedup on the brain drops the replays, but the
    // retry storm itself is waste). Telegram only needs a 2xx to stop, and a
    // `res` for an id with no pending entry is already dropped silently — the
    // exact path replayQueue uses. Send failure still answers 502 so a broken
    // uplink keeps its retries.
    if (kind === "telegram") {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        return new Response(JSON.stringify({ error: "uplink_send_failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, forwarded: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(new Response(JSON.stringify({ error: "brain_timeout" }), { status: 504 }));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(new Response(JSON.stringify({ error: "uplink_send_failed" }), { status: 502 }));
      }
    });
  }

  private failAllPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(new Response(JSON.stringify({ error: "brain_disconnected" }), { status: 502 }));
    }
    this.pending.clear();
  }

  /** `withSnapshot` is false for tenant-path routes, whose callers hold no key. */
  private offlineResponse(withSnapshot = true): Response {
    const snap = withSnapshot
      ? (this.sql.exec("SELECT v FROM kv WHERE k = 'snapshot'").toArray()[0]?.v as
          | string
          | undefined)
      : undefined;
    // "Last online at" is the operator's presence; it goes with the snapshot or not at all.
    const at = withSnapshot
      ? (this.sql.exec("SELECT v FROM kv WHERE k = 'snapshot_at'").toArray()[0]?.v as
          | string
          | undefined)
      : undefined;
    return new Response(
      JSON.stringify({
        offline: true,
        since: at ? Number(at) : null,
        snapshot: snap ? JSON.parse(snap) : null,
      }),
      {
        // 503 so the deck's existing "unreachable" path keeps the last-known
        // UI instead of rendering the offline envelope as real data; the
        // header + body let it show a "brain offline" banner + cached snapshot.
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-navig-brain": "offline",
          "retry-after": "10",
        },
      },
    );
  }

  // ── Offline queue ────────────────────────────────────────────────────────────

  private enqueue(kind: string, path: string, headers: Record<string, string>, body: string): void {
    this.sql.exec(
      "INSERT INTO queue (kind, path, headers, body, created) VALUES (?, ?, ?, ?, ?)",
      kind,
      path,
      JSON.stringify(headers),
      body,
      Date.now(),
    );
    // Trim the oldest beyond the cap so an offline brain can't grow this forever.
    this.sql.exec(
      `DELETE FROM queue WHERE id IN (
         SELECT id FROM queue ORDER BY id DESC LIMIT -1 OFFSET ?
       )`,
      MAX_QUEUE,
    );
  }

  private async replayQueue(ws: WebSocket): Promise<void> {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    this.sql.exec("DELETE FROM queue WHERE created < ?", cutoff);
    const rows = this.sql.exec("SELECT * FROM queue ORDER BY id ASC").toArray();
    for (const row of rows) {
      const frame: ReqFrame = {
        t: "req",
        id: crypto.randomUUID(), // replay is fire-and-forget; the caller is long gone
        kind: row.kind as ReqFrame["kind"],
        method: "POST",
        path: row.path as string,
        headers: JSON.parse(row.headers as string),
        body: row.body as string,
      };
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        return; // socket died mid-replay; leave the rest queued for next time
      }
    }
    this.sql.exec("DELETE FROM queue");
  }

  // ── SSE fanout ───────────────────────────────────────────────────────────────

  private openSse(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.sse.add(writer);
    // Prelude: open the stream + tell the client whether the brain is live.
    const live = this.liveSocket() ? "online" : "offline";
    writer
      .write(this.encoder.encode(`: navig-lighthouse\nevent: hello\ndata: {"brain":"${live}"}\n\n`))
      .catch(() => this.dropSse(writer));
    // Heartbeat keeps the stream alive through proxies (mirrors the daemon's
    // 20s `: heartbeat`); on write failure the client is gone — prune it.
    const beat = setInterval(() => {
      writer.write(this.encoder.encode(": heartbeat\n\n")).catch(() => {
        clearInterval(beat);
        this.dropSse(writer);
      });
    }, 20_000);
    this.heartbeats.set(writer, beat);
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private dropSse(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    const beat = this.heartbeats.get(writer);
    if (beat !== undefined) {
      clearInterval(beat);
      this.heartbeats.delete(writer);
    }
    this.sse.delete(writer);
  }

  private fanout(event: string, data: string): void {
    const chunk = this.encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
    for (const writer of this.sse) {
      writer.write(chunk).catch(() => this.dropSse(writer));
    }
  }
}
