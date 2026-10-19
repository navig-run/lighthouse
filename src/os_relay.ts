/**
 * NAVIG OS over Lighthouse — the pure half of the edge's OS channel.
 *
 * A phone or browser (os.navig.run) opens `wss://<edge>/os/<tenant>/connect`. The Durable
 * Object accepts it as an `os` socket and multiplexes it over the brain's ONE outbound
 * uplink by stream id (sid). The brain authenticates the device, dials the NAVIG OS server
 * on the PC, and pipes both ways. The edge never sees a credential it can check; it is a
 * pipe with limits.
 *
 * Everything here is pure and import-free, so `node --test` runs it with no install.
 *
 * Wire format on the uplink:
 *   data     `@<sid>:<payload>`   both directions; the edge only slices the prefix, never
 *                                 parses the payload. An old brain's json.loads drops it.
 *   control  JSON                 os_open · os_ok · os_close · retire (see protocol.ts).
 */

/** The capability the brain declares in `hello` when it can relay NAVIG OS. */
export const OS_CAP = "os1";

/** Authenticated sessions per tenant. A phone and a laptop or two, with room to spare. */
export const OS_MAX_AUTHED = 8;
/**
 * Sockets that have not yet proven a device (the brain closes them after 5 s). Kept small
 * and per-IP so a stranger who knows the tenant id cannot fill the authed slots' door.
 */
export const OS_MAX_PREAUTH = 4;
export const OS_MAX_PREAUTH_PER_IP = 2;
/**
 * Largest single message a browser may send the edge. The hosted adapter fragments
 * anything bigger (a 2.7 MB session-import chunk, a base64 upload), so this cap bounds DO
 * memory without costing a feature.
 */
export const OS_MAX_INBOUND_BYTES = 1024 * 1024;

/** The keepalive the hosted adapter sends; answered by the runtime without waking the DO. */
export const KEEPALIVE = '{"t":"ka"}';

/**
 * Close codes the hosted app maps to a sentence. 4000-4999 is the application range, and a
 * reason must fit in 123 bytes. Accept-then-close is the only way a browser learns why: a
 * refused upgrade reaches page script as a bare 1006.
 */
export const CLOSE = {
  /** The brain's uplink is not connected: the computer is off, asleep, or offline. */
  OFFLINE: 4503,
  /** The relay was retired (the deck key rotated) — this pairing points nowhere now. */
  RETIRED: 4404,
  /** The brain is connected but predates the OS channel. */
  UPDATE_NAVIG: 4426,
  /** The brain is up but NAVIG OS is not running on the PC. */
  OS_NOT_RUNNING: 4410,
  /** Unknown or revoked device. */
  DEVICE: 4401,
  /** A cap: sessions, pending connections, budget, or a client too slow to keep up. */
  LIMIT: 4429,
  /** The uplink restarted; transient, the client reconnects. */
  UPLINK_RESTART: 1012,
  TOO_BIG: 1009,
  UNSUPPORTED: 1003,
} as const;

export type SocketRole = "uplink" | "os";

/**
 * What a hibernated socket is, from its tags. Tags are fixed at accept time and survive
 * hibernation, which is why they — not an in-memory map — decide this.
 *
 * An untagged socket can only be an uplink accepted by an edge older than this channel
 * (a deploy restarts the DO, so in practice none survive); treating it as the uplink is
 * the conservative reading. A browser socket is ALWAYS tagged `os`, so it can never be
 * mistaken for the uplink — which matters: the uplink's `hello` replays queued Telegram
 * webhooks, secret-token headers included, down whichever socket sent it.
 */
export function socketRole(tags: readonly string[]): SocketRole {
  return tags.includes("os") ? "os" : "uplink";
}

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sidTag(sid: string): string {
  return `sid:${sid}`;
}

export function sidFromTags(tags: readonly string[]): string | null {
  for (const t of tags) {
    if (t.startsWith("sid:")) {
      const sid = t.slice(4);
      return SID_RE.test(sid) ? sid : null;
    }
  }
  return null;
}

export function encodeData(sid: string, payload: string): string {
  return `@${sid}:${payload}`;
}

/** `@<sid>:<payload>` → parts, or null for anything else (JSON control frames included). */
export function parseDataFrame(message: string): { sid: string; payload: string } | null {
  if (!message.startsWith("@")) return null;
  const colon = message.indexOf(":");
  if (colon !== 37) return null; // "@" + 36-char uuid
  const sid = message.slice(1, colon);
  if (!SID_RE.test(sid)) return null;
  return { sid, payload: message.slice(colon + 1) };
}

/** What the DO knows when a browser asks to connect. */
export interface OpenState {
  retired: boolean;
  uplinkOpen: boolean;
  /** Capabilities from the uplink's `hello`, persisted on the socket's attachment. */
  uplinkCaps: readonly string[];
  authed: number;
  preauth: number;
  preauthFromIp: number;
}

export type OpenDecision =
  | { accept: true }
  | { accept: false; code: number; reason: string };

/**
 * Accept this browser socket, or close it with the code that says why.
 * Ordered by what the user can do about it: a retired relay needs a new pairing whatever
 * else is true, an offline computer needs waking before an update can matter, and so on.
 */
export function decideOpen(s: OpenState): OpenDecision {
  if (s.retired) return { accept: false, code: CLOSE.RETIRED, reason: "relay moved: pair again" };
  if (!s.uplinkOpen) return { accept: false, code: CLOSE.OFFLINE, reason: "computer offline" };
  if (!s.uplinkCaps.includes(OS_CAP)) {
    return { accept: false, code: CLOSE.UPDATE_NAVIG, reason: "update NAVIG on your computer" };
  }
  if (s.authed >= OS_MAX_AUTHED) return { accept: false, code: CLOSE.LIMIT, reason: "too many sessions" };
  if (s.preauth >= OS_MAX_PREAUTH || s.preauthFromIp >= OS_MAX_PREAUTH_PER_IP) {
    return { accept: false, code: CLOSE.LIMIT, reason: "too many pending connections" };
  }
  return { accept: true };
}

/** A close code a server may actually send (1005/1006/1015 are reserved for the local side). */
export function sendableCloseCode(code: unknown): number {
  const n = typeof code === "number" && Number.isInteger(code) ? code : 1000;
  if (n === 1000 || (n >= 3000 && n <= 4999)) return n;
  if (n >= 1001 && n <= 1014 && n !== 1004 && n !== 1005 && n !== 1006) return n;
  return 4000;
}

/** Close reasons are capped at 123 UTF-8 bytes by the WebSocket spec; longer throws. */
export function sendableCloseReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= 123) return text;
  let cut = text.slice(0, 120);
  while (new TextEncoder().encode(cut).length > 120) cut = cut.slice(0, -1);
  return cut;
}
