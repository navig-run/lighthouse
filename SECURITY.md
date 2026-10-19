# Security Policy

NAVIG Lighthouse is a self-hosted edge that sits in front of a user's NAVIG
brain, so we take its security seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report privately via either:

- GitHub's [private vulnerability reporting](https://github.com/navig-run/lighthouse/security/advisories/new)
  (Security → Report a vulnerability), or
- email **security@navig.run**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal PoC if possible),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge reports within **72 hours** and to provide a remediation
timeline after triage. Please give us a reasonable window to ship a fix before
any public disclosure; we're happy to credit you in the release notes.

## Scope

In scope:

- the Worker and Durable Object in this repository (`src/**`, `wrangler.jsonc`),
- auth/tenancy logic (Bearer key handling, `sha256(api_key)` path derivation,
  Telegram secret-header and SMS-signature checks),
- any path that could let one tenant reach another tenant's brain, or let an
  unauthenticated caller reach a brain.

Out of scope:

- vulnerabilities in Cloudflare's platform itself (report to Cloudflare),
- the user's own NAVIG brain, deck, or Cloudflare account configuration,
- denial-of-service from sending large volumes of traffic to your own deploy.

## Design invariants (what "secure" means here)

- The edge holds **no** NAVIG secrets, bot tokens, or user credentials.
- Every public route authenticates before it reaches a brain.
- Tenancy is isolated per `sha256(api_key)` — no path crosses tenants.

A report that demonstrates a break of any of these invariants is always in scope.
