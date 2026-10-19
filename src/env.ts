/// <reference types="@cloudflare/workers-types" />

/**
 * Bindings for the Lighthouse Worker. Deliberately tiny — Lighthouse is a
 * pure transport that the user deploys to THEIR Cloudflare account, so it
 * carries no billing/licensing secrets (those live only in navig-api).
 *
 * Storage is the BrainSocket Durable Object alone (DO SQLite handles the
 * offline snapshot + replay queue), which keeps the no-Node deploy a single
 * script upload with no D1/Queue provisioning required on the free plan.
 */
export interface Env {
  /** BrainSocket DO namespace — one instance per brain (sha256(api_key)). */
  BRAIN: DurableObjectNamespace;
  /**
   * Optional per-tenant inbound request cap (sustained requests/minute) applied
   * inside the DO to blunt a flood at a single brain's uplink (notably the
   * unauthenticated /ingest path). Defaults to 600/min when unset. Set to "0"
   * to disable. Cloudflare vars are strings, so this is parsed as a number.
   */
  RATE_LIMIT_PER_MIN?: string;
}
