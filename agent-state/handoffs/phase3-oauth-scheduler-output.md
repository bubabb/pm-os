# Handoff — Phase 3 Tasks 6 & 7 (Real OAuth + Background Sync)

**Status:** code-complete, UNVERIFIED (Kali peer — no toolchain). Phase 3 task list now closed.

## What shipped
- **Task 6 — Real OAuth** (GitHub + Entra), browser-window auth-code flow with env-driven
  client credentials and a dev-stub fallback when unconfigured.
  - NEW `apps/desktop/src/main/auth/oauth-service.ts`
  - MOD `apps/desktop/src/main/auth/auth-service.ts` (`upsertOAuthUser`)
  - MOD `apps/desktop/src/main/auth/index.ts` (exports)
  - MOD `apps/desktop/src/main/routes/auth.ts` (`/auth/sign-in` real-or-stub)
- **Task 7 — Background sync scheduler**, main-process interval with overlap guard,
  expired-token skip, per-project isolation, one system event per cycle.
  - NEW `apps/desktop/src/main/scheduler/sync-scheduler.ts`
  - MOD `apps/desktop/src/main/index.ts` (lifecycle wiring)

## Blocking before "done"
1. **On the Mac:** `pnpm -r exec tsc --noEmit` + vitest — covers this session AND the
   still-uncommitted Domain 2 + review-fix work.
2. Commit everything together → Phase 3 complete.

## Runtime config (env, optional in dev)
```
PMOS_GITHUB_CLIENT_ID / PMOS_GITHUB_CLIENT_SECRET
PMOS_ENTRA_CLIENT_ID / PMOS_ENTRA_CLIENT_SECRET / PMOS_ENTRA_TENANT_ID
PMOS_OAUTH_REDIRECT_URI   (default http://localhost:4321/auth/oauth/callback)
PMOS_SYNC_INTERVAL_MS     (default 900000; 0 disables the scheduler)
```
Without OAuth env vars, sign-in transparently uses the dev-user stub.
