# Creare — Agent Log
Append-only. Never overwrite entries. Add new entries at the bottom.

---

## 2026-06-02 — Phase 0 Complete (Human + Claude)
**Tasks completed:** #1, #2, #3, #16, #19 — all Phase 0 tasks complete
**Summary:** Full Phase 0 delivered and reviewed twice. Product named Creare (creare.dev). Tech stack approved. Monorepo scaffolded (84 files, 5 commits). 20-table schema with 10 indexes, 3 append-only tables, AES-256-GCM secrets. All docs updated: GLOSSARY 23 terms, AGENT-PROTOCOL fixed, 5 CONTRACT.md files active, 4 Phase 1 task files created, data-models.md v1.1, project-scope.md v1.2.
**Next:** Phase 1 — Tasks #4 (auth) and #5 (database/API) can run in parallel. Task #6 (UI shell) blocked by #5. Task #17 (notifications) blocked by #5.

---

## 2026-06-08 — Phase 3: Domain 2 Tool Registry (Claude)
**Tasks completed:** Domain 2 — Tool Registry (implementation)
**Summary:** Replaced tool-registry stub with full domain API: tool CRUD, immutable version publishing (repoints latestVersionId), single-active deployments, and non-destructive rollback — all emitting events to the append-only log. Added desktop routes (tools.ts, registered in server.ts) and ToolsPage.tsx (master-detail registry UI), wired into App.tsx replacing the placeholder. CONTRACT.md → v1.1 (synchronous API + actorId params, matching boards/agent-orchestration conventions).
**Verification:** tsc NOT run locally — Kali box has no node_modules/pnpm and packages are unbuilt; full install blocked by missing `.stignore` (would sync Linux node_modules to the Mac). Must run `tsc --noEmit` on the Mac before marking complete.
**Next:** Phase 3 Task 6 (Real OAuth — GitHub + Entra) and Task 7 (background sync scheduler).

---

## 2026-06-09 — Phase 3 Review + Fixes (Claude)
**Tasks completed:** Full review of all Phase 3 (Domains 1–4 + Settings + wiring); applied the complete fix set (~24 files).
**Summary:** Fixed a Boards milestone-status runtime crash (UI enum mismatch); `exactOptionalPropertyTypes` violations blocking tsc (AgentsPage + observability — boards/observability had never been compiled); systemic IDOR via sub-resource ownership guards on all domain routes; completed append-only event coverage (workspace/task/sprint/milestone) with actorId threading; made sequenceNumber, single-active-sprint, and DAG cycle-detection transactional; added `superseded` to tool_deployments.status (additive schema change); N+1 → LEFT JOINs; Settings error handling; POST /audit-log; `lastSyncedAt` desc. Discarded one false-positive (classifyItems — stale integrations contract). Contracts updated.
**Verification:** tsc/vitest NOT run (Linux peer, no toolchain). Cross-file greps clean. MUST run `pnpm -r exec tsc --noEmit` + tests on the Mac, then commit.
**Next:** Phase 3 Task 6 (Real OAuth), Task 7 (background sync scheduler).

---

## 2026-06-09 — Phase 3 Tasks 6 & 7 — Real OAuth + Background Sync (Claude)
**Tasks completed:** Task 6 (Real OAuth sign-in, GitHub + Entra) and Task 7 (background sync scheduler). This closes the Phase 3 task list.
**Summary:**
- **Task 6 — Real OAuth.** New `apps/desktop/src/main/auth/oauth-service.ts`: browser-window authorization-code flow for GitHub + Microsoft Entra. Opens a modal `BrowserWindow`, intercepts the loopback redirect in-process (no HTTP listener), validates `state` (CSRF), exchanges the code for an access token, and fetches the profile (GitHub `/user` + `/user/emails`; Graph `/me`). Client credentials read from env (`CREARE_GITHUB_CLIENT_ID/SECRET`, `CREARE_ENTRA_CLIENT_ID/SECRET`, `CREARE_ENTRA_TENANT_ID`, `CREARE_OAUTH_REDIRECT_URI`). Added `upsertOAuthUser()` to auth-service (upsert by email, refresh name/avatar). Rewired `POST /auth/sign-in`: real OAuth when configured, **falls back to the Phase 1 dev-user stub** when env vars are absent so dev still works. Sign-in event payload now records `method: oauth|dev-stub`. Barrel exports updated.
- **Task 7 — Background sync scheduler.** New `apps/desktop/src/main/scheduler/sync-scheduler.ts`: main-process `setInterval` (default 15 min, `CREARE_SYNC_INTERVAL_MS`, 0=disabled). Each cycle syncs every non-archived project's credentials via `triggerSync`, skips expired tokens (`isTokenExpired`), isolates per-project failures, guards against overlapping cycles, and emits one `integration.sync.scheduled` system event per cycle. Wired `startSyncScheduler()`/`stopSyncScheduler()` into the Electron lifecycle in `index.ts`.
**Verification:** tsc/vitest NOT run — Kali peer has no toolchain. Self-reviewed: all cross-package/barrel imports confirmed present (triggerSync, getIntegrationToken/isTokenExpired, generateId, User type); events null columns confirmed nullable; OAuth event-handler types inferred from listener signatures (no reliance on global `Electron.Event`); `user` annotated `User` for strict definite-assignment. MUST run `pnpm -r exec tsc --noEmit` + tests on the Mac, then commit (along with the still-uncommitted Domain 2 + review-fix work).
**Next:** Mac verification pass for ALL uncommitted Phase 3 work (Domain 2, review fixes, Tasks 6 & 7) → commit → Phase 3 complete. Provider OAuth apps must be registered and env vars set before real sign-in works end-to-end.

---

## 2026-06-09 — Phase 3 Final Review + Fixes (Claude)
**Tasks completed:** Final review of ALL uncommitted Phase 3 (3 parallel reviewers + manual verification of every high-severity claim), then applied the full verified fix set.
**Summary:** Reviewers produced several confident false positives that were verified-and-discarded (the "deploy/createBoard/_canReach not atomic because they use getDb() not tx" criticals — moot on better-sqlite3's single synchronous connection; sprint-reader "await on better-sqlite3 is a tsc error" — drizzle builders are thenable; sprint-reader endDate narrowing — guarded). Manual reading caught a real tsc-blocker the agents MISSED. Fixes applied:
- **tsc-blocker:** `routes/boards.ts` lines 24/28 used `interface X Partial<...>` (invalid) → changed to `type X = Partial<...>`.
- **IDOR (real, verified):** added leaf-ownership guards — `routes/boards.ts` now checks column∈board (updateColumn/deleteColumn/addBoardItem/moveBoardItem) and item∈board (moveBoardItem/removeBoardItem) via new domain getters `getColumn`/`getBoardItem`; `routes/orchestration.ts` now checks gate∈project via new `getApprovalGate` + `gateInProject`.
- **exactOptionalPropertyTypes:** `boards.updateColumn`/`updateSprint` switched from Partial-spread to guarded `patch`; `addBoardItem` route call uses conditional spread for storyPoints/sprintId.
- **event attribution:** `createWorkspace` and `addEdge` now take `actorId` (threaded from the route's user) instead of hardcoded 'user'/null/own-id.
- **error-atomicity:** `tool-registry` publishVersion/deploy/rollback wrapped in `db.transaction`; `_logEvent` gained a `resourceType` param so version/deployment events are labeled `tool_version`/`tool_deployment` (were all 'tool').
- **Task 6/7 cleanups:** `routes/auth.ts` now uses `createSessionToken` (removed duplicated inline SignJWT + JWT consts); `sync-scheduler` uses `Promise.allSettled` (one bad credential no longer drops a project's healthy creds) and resets the overlap guard in `stop()`; `oauth-service` ignores the second will-redirect/will-navigate after settle; `auth-service` documents the local-first `role:'admin'` default.
**Verification:** tsc/vitest still NOT run (Kali, no toolchain). Post-fix greps clean: no malformed interfaces, no stale JWT refs, all `_logEvent` call sites match new arity, 3 transactions present, no orphaned callers. MUST run `pnpm -r exec tsc --noEmit` + tests on the Mac, then commit.
**Next:** Mac verify → commit ALL Phase 3 work → Phase 3 complete.

---

## 2026-06-09 — Phase 4 Start: Eval & Intelligence (Claude)
**Tasks completed:** Built all four Phase 4 workstreams (user chose "all"): (1) test foundation, (2) tool regression harness, (3) AI eval harness, (4) team memory/adaptive learning.
**Summary:**
- **Test foundation.** Root `vitest.config.ts` aliases every `@creare/*` to its TS source (anchored regexes so `@creare/database` doesn't shadow the `@creare/database/testing` subpath); root `test` script → `vitest run`; `tsconfig.base.json` now excludes `**/*.test.ts(x)`/`**/*.spec.ts`/`**/testing.ts` from the CJS builds. `@creare/database`: `client.ts` gained `setDb`/`resetDb`; new build-excluded `testing.ts` with `createTestDb()` (in-memory + real migrations via drizzle migrator) and `seedUser/seedProject/seedTask/seedWorkspace`. Seed regression suites for shared, tool-registry, boards, agent-orchestration (these also cover the Phase 3 fixes — single-active deploy/sprint, rollback, DAG cycle detection).
- **`packages/eval` (NEW).** Tool regression (`runToolRegression`, `validateToolSchema`, `deepEqual`, caller-supplied `ToolExecutor` since no execution engine exists yet) + AI eval (`EvalCase`, scorers `exactMatch`/`includes`/`regexMatch`, `runEval`, `makeModelRunner`/`makeLlmJudge` over ai-sdk, `persistEvalRun`/`listEvalRuns`). Self-tests use stubs (no live API).
- **`packages/memory` (NEW).** `recordLearning` (+ append-only event), `listLearnings`, `recallLearnings` (tag+keyword ranking) over a new `learnings` table.
- **Schema.** New `eval_runs` + `learnings` tables + types; SCHEMA_VERSION 1.3.0; migration `0002_phase4_eval_intelligence.sql` + journal idx 2 (runtime migrate uses journal+SQL; NO meta snapshot generated — regen via `db:generate` on Mac for future-migration coherence).
**Verification:** NOTHING run (Kali, no toolchain). MUST on Mac: `pnpm install` (picks up eval+memory+root vitest deps), `pnpm -r exec tsc --noEmit`, `pnpm test` (8 suites via root config).
**Next:** On Mac — install + tsc + test, fix fallout, commit (Phase 3 + Phase 4 together or separately). Follow-ups: domain suites for observability/integrations/reporting; Playwright E2E; eval/memory desktop routes+UI.

---

## 2026-06-09 — Phase 4 Review + Fixes (Claude)
**Tasks completed:** Reviewed all Phase 4 (3 parallel reviewers + manual verification), applied the verified fix set.
**Summary:** Reviewers flagged the events-insert `.catch()` in memory as a "TypeError" — verified FALSE (drizzle builders are thenable; the routes use `.catch()` and the domain `_logEvent`s use `.run()`), but switched memory to `.run()` anyway for domain consistency. Real fixes applied: (1) `vitest.config.ts` add `pool: 'forks'` — the default 'threads' pool segfaults loading native better-sqlite3, would have blocked `pnpm test`; (2) `testing.ts` `destroyTestDb()` now calls `resetDb()` so a closed handle is never reused; (3) `memory` event insert `.catch()`→`.run()`; (4) memory test no longer asserts sub-millisecond newest-first ordering (created_at ties → SQLite gives no order guarantee) — asserts membership instead; (5) `eval-runner` renamed shadowing `passed`→`passedCount`; (6) `makeModelRunner` gained optional `maxTokens` for cost capping; (7) `@creare/database` devDep `drizzle-kit ^0.20.0`→`^0.31.0` to match drizzle-orm 0.45 (the db:generate scripts already pinned 0.31.10) so the 0002 snapshot can be regenerated on Mac.
**Verification:** still nothing run on Kali. Post-fix greps clean. Mac TODO unchanged: `pnpm install` + `pnpm -r exec tsc --noEmit` + `pnpm test`; then `db:generate` to emit meta/0002_snapshot.json.
**Next:** Mac verify + commit.

---

## 2026-06-09 — Phase 4 Test Coverage Expansion (Claude)
**Tasks completed:** Added domain test suites for the 3 previously-uncovered domains (observability, integrations, reporting), closing the Phase 4 coverage gap.
**Summary:** New `testing.ts` helpers `seedAgentWorkspace(projectId)` and `seedCredential(projectId)` (FK prerequisites for traces/cost and sync/event-cache). New suites: `observability/src/index.test.ts` (traces CRUD, monotonic trace-event sequence numbers, audit log + filter, event-log surfacing a task.created event from agent-orchestration), `reporting/src/cost-tracking.test.ts` (recordCost/getProjectSpend totals + per-workspace breakdown + since filter), `integrations/src/index.test.ts` (getActiveEvents excludes purged + source/entityType filters, getSyncStatus mapping). Scoped to no-network/no-AI functions; triggerSync/classifyItems/generatePmDigest/nl-queries left for integration-level tests. Total: 11 suites.
**Verification:** still nothing run on Kali. Mac TODO unchanged: `pnpm install` + `pnpm -r exec tsc --noEmit` + `pnpm test`.
**Next:** Mac verify + commit. Remaining follow-ups: Playwright E2E; eval/memory desktop routes+UI; 0002 meta snapshot via db:generate.

---

## 2026-06-09 — Repo relocation into ~/projects mother folder (Claude, Kali)
**Tasks completed:** Migrated the whole repo `~/Creare Project` → `~/projects/creare`; no file content changed (git history intact).
**Summary:** Created a `~/projects` mother folder synced to the Mac as ONE Syncthing folder (id `projects`, send-receive) with a `.stignore` that finally excludes node_modules/dist/build/etc. Old Syncthing folder `nm9f2-cfxq6` (`~/Creare Project`) removed from Kali config FIRST (so the move didn't propagate deletions to the Mac); the Mac still holds the orphaned `~/Creare Project` copy as a safety net. Added per-project `.claude/` (deepreview + done-for-the-day hooks → `$CLAUDE_PROJECT_DIR/.claude/*.md`, so they fire on the Mac too) and appended a Workflows section to `CLAUDE.md`. PROGRESS.md unchanged in substance.
**Verification:** Syncthing `projects` folder: idle, 1473 files, 0 errors, `.stignore` 26 lines loaded. Build state of the code itself STILL unverified (no tsc/tests on Kali).
**Mac action required:** (1) accept the new `projects` folder on the Mac (path `~/projects`); (2) build from `~/projects/creare` now, not `~/Creare Project`; (3) once verified, delete the orphaned `~/Creare Project` on the Mac; (4) approve per-project hooks when prompted.
**Next:** unchanged — Mac verify + commit the Phase 3/4 work (now incl. PROGRESS.md, .claude/, CLAUDE.md additions). No Co-Authored-By trailer.

---

## 2026-06-09 — Full deepreview + fixes, VERIFIED GREEN on Kali (Claude, Kali)
**Tasks completed:** Ran a full uncommitted deepreview (5 parallel reviewers + adversarial re-verify), applied the real fixes, **installed the toolchain on Kali and verified the whole tree green** (typecheck 21/21, tests 44/44), and regenerated migration 0002's meta snapshot.
**Summary:** Event-log completeness — `boards/src/index.ts` 8 silent mutations (createColumn/updateColumn/deleteColumn/updateSprint/addBoardItem/moveBoardItem/removeBoardItem/addMilestoneTask) now emit events; `eval` persistEvalRun emits `eval_run.persisted`; `reporting` recordCost emits `cost.recorded`. Scheduler teardown race — `stopSyncScheduler` is async + awaits the in-flight cycle (`cyclePromise`), awaited in `index.ts`. Security — OAuth PKCE (S256) on GitHub+Entra + exact redirect-URI match (was `startsWith`); Fastify dev logger redacts authorization/set-cookie. Cleanups — BoardsPage dead `select` callback removed; AgentsPage approval-gates query key gains `'pending'`. REJECTED as false positives (left untouched): async/await-on-better-sqlite3 "crashes" (await works across the committed codebase), `exactOptionalPropertyTypes` "build failures" (avatarUrl/expiresAt are nullable cols, moveBoardItem sprintId is positional), negative-interval "runaway" (`ms<=0` already disables). Migration 0002 regenerated via drizzle-kit so SQL + `0002_snapshot.json` + journal are consistent — regenerated DDL is identical to the hand-written (eval_runs + learnings).
**Verification (ACTUALLY RUN ON KALI):** `corepack` pnpm@9 → `pnpm install --ignore-scripts` → `pnpm run typecheck` = 21/21 tasks pass; compiled better-sqlite3 native via `node-gyp` → `pnpm test` = 11 files / 44 tests pass (re-run green after 0002 regen). Confirms `.returning()` works on better-sqlite3. `pnpm-lock.yaml` regenerated to include Phase 4 deps (was stale → a frozen install would have failed). NOTE: Kali CAN build/test now (the "Mac-only" rule is obsolete) — `~/projects/.stignore` shields node_modules from syncing.
**Next:** committing (Phase 3 remainder, then Phase 4), no Co-Authored-By. On Mac: pull, `pnpm install`, re-run typecheck+test for parity; approve per-project hooks.
