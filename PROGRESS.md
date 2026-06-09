# Creare — PROGRESS

At-a-glance resume snapshot. **Read this first** when picking the project back up.
This is the current-state pointer; the append-only detail log is
`agent-state/agent-log.md`, per-domain state is `agent-state/domain-state/`,
and cross-task handoffs are `agent-state/handoffs/`.

**Updated:** 2026-06-09

---

## STATUS NOW
- **Phase 3 (Domains 1–6 + Settings + wiring): COMPLETE, verified green on Kali, committed.**
  Domain 2 tool-registry, the Phase 3 review-fix set, Task 6 Real OAuth (GitHub + Entra),
  Task 7 background sync scheduler — all in.
- **Phase 4 (Eval & Intelligence): verified green on Kali, committed.**
  Test foundation (`vitest.config.ts`, `@creare/database/testing`), new
  `packages/eval` + `packages/memory`, schema additions (`eval_runs`,
  `learnings`, SCHEMA_VERSION 1.3.0, migration `0002` + snapshot), 11 test suites.
- **Verified 2026-06-09 ON KALI:** `pnpm run typecheck` 21/21 · `pnpm test` 44/44.
  Plus a full deepreview + fixes (event-log completeness, scheduler race, OAuth PKCE).

## BLOCKERS / CONSTRAINTS
- **Kali CAN build/typecheck/test now** (old "Mac-only" rule obsolete): `~/projects/.stignore`
  shields `node_modules`/`dist` from syncing. Procedure: `corepack prepare pnpm@9.0.0 --activate`
  + `corepack enable --install-directory ~/.local/bin pnpm` (PATH); `pnpm install --ignore-scripts`;
  `pnpm run typecheck`. For `pnpm test`, compile the native addon first:
  `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx -y node-gyp rebuild --release`.
- `migration 0002` snapshot — ✅ DONE (regenerated; `meta/0002_snapshot.json` present).
- The Linux-compiled `better-sqlite3` `.node` lives under stignored `node_modules` (no Mac clobber);
  the Mac rebuilds its own on `pnpm install`.

## RESUME HERE (next step, in order)
Phase 3 + Phase 4 are committed and verified green on Kali. Remaining:
1. On the **Mac**: pull, `pnpm install`, re-run `pnpm run typecheck` + `pnpm test` for parity
   (the Mac rebuilds its own native `better-sqlite3`); approve per-project hooks on first open.
2. Then the FOLLOW-UPS below.

## FOLLOW-UPS (after green build)
- Test suites for observability / integrations / reporting domains.
- Playwright E2E.
- Routes + UI for eval and memory packages.

---
*Conventions: synchronous `getDb()` domain APIs; append-only `events` log on every
mutation; UUIDs via `generateId()`; no `any`; `exactOptionalPropertyTypes`.*
*On "done for the day", update this file's STATUS NOW / RESUME HERE and the
auto-memory pointer ([[project-creare]]).*
