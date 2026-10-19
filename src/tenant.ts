/**
 * Tenant identity for the edge — the one shape every brain address takes.
 *
 * A tenant is `sha256(deck.api_key)` as lowercase hex; the Python brain says so
 * in as many words (`navig/cloud/uplink.py`: "The tenant id Lighthouse routes
 * on: sha256(api_key) as lowercase hex") and derives every public URL from it —
 * `/tg/<tenant>`, `/sms/<tenant>`, `/ingest/<tenant>/<source>`.
 *
 * Bearer-authenticated routes compute that hash from the key the caller proved
 * it holds. The three webhook routes cannot: their callers (Telegram, a Twilio
 * console, the user's own website) hold no key, so the tenant arrives as an
 * opaque path segment and the brain does the real signature check.
 *
 * That makes the segment ATTACKER-CONTROLLED, and it is fed to
 * `env.BRAIN.idFromName(...)`. Every distinct string is a distinct Durable
 * Object: a loop over random paths instantiates unbounded DOs on the USER'S OWN
 * Cloudflare account, each one running its constructor's `CREATE TABLE` and
 * billing them for the privilege. The DO's own per-tenant rate limit cannot see
 * this — it is per-DO, so a new tenant is a new, full token bucket. The only
 * place to stop it is before the stub is ever created.
 *
 * Checking the shape costs one regex and cannot reject a legitimate caller,
 * because the brain generates these paths from a hash.
 */

/** `sha256(api_key)` as lowercase hex — 64 chars, nothing else. */
export const TENANT_RE = /^[0-9a-f]{64}$/;

/** Is this path segment shaped like a real tenant id? */
export function isTenantId(segment: string | undefined | null): boolean {
  return typeof segment === "string" && TENANT_RE.test(segment);
}

/** Lowercase-hex SHA-256, the derivation both the brain and the edge use. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
