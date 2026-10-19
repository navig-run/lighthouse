# Contributing to navig-lighthouse

Thanks for helping improve NAVIG Lighthouse. It's a small, security-sensitive
Cloudflare Worker, so the contribution bar is simple but firm.

## Ground rules

1. **The edge stays secret-free.** Lighthouse must never store or require a
   NAVIG secret, bot token, or user credential. Tenancy is derived from
   `sha256(api_key)` only. Any change that puts a secret on the edge will be
   rejected.
2. **Keep it free-tier viable.** The default deploy must work on Cloudflare's
   free Workers plan (DO-SQLite only). Paid features (Queues, R2) stay optional
   and behind flags.
3. **No new inbound trust.** Every public path must authenticate (Bearer key,
   Telegram secret header, or provider signature checked by the brain).

## Dev setup

```bash
npm install
npm run typecheck      # tsc --noEmit — must pass
npm run build:bundle   # wrangler dry-run build — must pass
npm run dev            # local wrangler dev server
```

Local secrets for `wrangler dev` go in `.dev.vars` (git-ignored) — never commit
them.

## Before you open a PR

- `npm run typecheck` passes (zero errors).
- `npm run build:bundle` passes (the Worker compiles for the CF runtime).
- New behavior is reflected in the README's routing/offline tables if it changes
  the public surface.
- Commits are focused; describe the *why*, not just the *what*.

## Pull requests

- Branch from `main`, open the PR against `main`.
- Keep PRs small and single-purpose.
- The CI workflow runs `typecheck` + `build:bundle` on every PR; both must be
  green.

## Reporting bugs / requesting features

Use the issue templates. For **security** issues, do **not** open a public
issue — follow [SECURITY.md](./SECURITY.md).
