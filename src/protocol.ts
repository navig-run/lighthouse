/// <reference types="@cloudflare/workers-types" />
/**
 * Lighthouse uplink wire protocol — the single source of truth shared (in
 * spirit) with the Python brain in `navig/cloud/uplink.py`. Keep the two in
 * sync: every frame `t` and field name here has a mirror there.
 *
 * The brain dials OUT to the edge over one persistent WebSocket. The edge
 * never connects in; it only ever receives this socket and pushes work down
 * it. All frames are JSON text (small bodies inline; large-body handling via
 * R2 is a documented future extension, see README).
 */

/** Edge → brain: a forwarded inbound request awaiting a reply. */
export interface ReqFrame {
  t: "req";
  /** Correlation id (matches the ResFrame.id the brain sends back). */
  id: string;
  /** Which brain handler should service this. */
  kind: "deck" | "telegram" | "sms";
  method: string;
  /** Path + query as seen by the brain (already stripped of the tenant prefix). */
  path: string;
  headers: Record<string, string>;
  /** Request body as a UTF-8 string ("" when none). */
  body: string;
}

/** Brain → edge: the reply to a ReqFrame. */
export interface ResFrame {
  t: "res";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Brain → edge: a server-sent event to fan out to attached SSE clients. */
export interface EventFrame {
  t: "event";
  /** SSE `event:` name (e.g. "notification", "ops", "status"). */
  event: string;
  /** SSE `data:` payload (already serialised by the brain). */
  data: string;
}

/**
 * Brain → edge: the latest status/stats snapshot. The edge persists this in
 * DO SQLite and serves it (with an "offline" flag) when the brain is asleep.
 */
export interface SnapshotFrame {
  t: "snapshot";
  /** Opaque JSON the deck understands; stored verbatim, served on offline GETs. */
  data: string;
}

/** Brain → edge: first frame after the socket opens; carries an initial snapshot. */
export interface HelloFrame {
  t: "hello";
  /** Brain/agent build, for diagnostics. */
  version?: string;
  /** Optional initial snapshot (same payload as SnapshotFrame.data). */
  snapshot?: string;
  /**
   * What this brain can do beyond the base protocol. `"os1"` = it relays NAVIG OS
   * streams (os_relay.ts). The edge persists this on the uplink socket's attachment so it
   * survives hibernation, and refuses an OS connection (4426) to a brain without it —
   * an older brain would silently drop os_open and leave the browser hanging.
   */
  caps?: string[];
}

/** Either direction: liveness keepalive (in addition to native WS pings). */
export interface PingFrame {
  t: "ping";
}
export interface PongFrame {
  t: "pong";
}

// ── NAVIG OS channel (edge ≥ 1.3.0, brain with caps "os1") ─────────────────────
// Data travels as `@<sid>:<payload>` text, not JSON (see os_relay.ts); these are the
// control frames around it.

/** Edge → brain: a browser opened an OS socket. Its first data frame is the OS handshake. */
export interface OsOpenFrame {
  t: "os_open";
  sid: string;
  /** Hints for the device list; never used for authentication. */
  ua?: string;
  ip?: string;
  country?: string;
}

/** Brain → edge: this socket proved a paired device; count it as authenticated. */
export interface OsOkFrame {
  t: "os_ok";
  sid: string;
  deviceId: string;
}

/** Either direction: the stream ended. Edge → brain when the browser left; brain → edge to close it. */
export interface OsCloseFrame {
  t: "os_close";
  sid: string;
  code: number;
  reason?: string;
}

/**
 * Brain → edge: this tenant is retired (the deck key rotated, so the brain now lives in
 * another Durable Object). OS connections here get 4404 "pair again" instead of an
 * "offline" that would never clear.
 */
export interface RetireFrame {
  t: "retire";
}

export type DownFrame = ReqFrame | PingFrame | OsOpenFrame | OsCloseFrame; // edge → brain
export type UpFrame =
  | ResFrame
  | EventFrame
  | SnapshotFrame
  | HelloFrame
  | PongFrame
  | OsOkFrame
  | OsCloseFrame
  | RetireFrame; // brain → edge

export type AnyFrame = DownFrame | UpFrame;

/** Path prefixes the edge forwards to the brain's in-process deck app. */
export const DECK_PREFIXES = ["/api/", "/runtime/", "/mesh/"];

/** The SSE endpoint the deck connects to (held open by the DO). */
export const SSE_PATH = "/api/events";

/**
 * May an offline reply to this path carry the brain's cached status snapshot?
 *
 * Only on the DECK_PREFIXES routes, which index.ts reaches through `viaBearer` — the
 * caller proved it holds the deck key. Tenant-path routes (`/ingest/<tenant>/…`, the
 * pairing route) need no key at all, and the tenant id is semi-public (it is in every
 * webhook URL), so a snapshot there hands the operator's status to anyone who asks.
 */
export function offlineSnapshotAllowed(pathname: string): boolean {
  return DECK_PREFIXES.some((p) => pathname.startsWith(p));
}
