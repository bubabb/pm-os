# Creare — PROGRESS

At-a-glance resume snapshot. **Read this first** when picking the project back up.
This is the current-state pointer; the append-only detail log is
`agent-state/agent-log.md`, per-domain state is `agent-state/domain-state/`,
and cross-task handoffs are `agent-state/handoffs/`.

**Updated:** 2026-06-10

---

## STATUS NOW
- **Deepreview fixes (2026-06-10, Fable 5, 3 batches): DONE, uncommitted.** typecheck 21/21 · tests **45/45** · build clean.
  Grounded UI+perf deepreview → all findings fixed:
  • **Backend/perf:** classification now CACHED on `external_event_cache` (cols `classification`/`classified_at`,
    migration `0006`, SCHEMA_VERSION → **1.7.0**) — dashboard no longer re-runs Claude per item per load;
    `getActiveEvents` newest-first (`desc`) not oldest; sync purge+insert now transactional + skips on empty
    fetch (a GitHub 403 no longer blanks the cache); base connector throws on 401/403/429/5xx; cache index
    `(credential_id,purged_at)` + 7-day retention delete; `agent-activity` dropped-WHERE fixed (was scanning all
    projects); `getReadyTasks` N+1 → 3 queries + `task_edges_to_idx`; ai-sdk pricing corrected (Opus 500/2500,
    Haiku 100/500 cents/MTok). +1 regression test (newest-first).
  • **Frontend perf:** Gantt date inputs use local draft + optimistic cache update (no per-keystroke refetch storm
    + snap-back bug); Gantt memoized (scale/maps); dashboard no longer blanks to a spinner on every nav;
    **route-level code-splitting** (9 lazy chunks, main bundle 599 KB → 366 KB); `refetchOnWindowFocus:false`;
    timeline cache invalidation on task mutations.
  • **UI/a11y:** app now actually renders **dark** (the `.dark` class was never applied); shared `Badge`/`QueryError`/`Field`
    components; consistent readable badges (fixed illegible Connections/Settings chips); query errors show an error+retry
    card instead of a fake empty state; `onError` on all mutations; aria-labels on icon buttons; DelegateConfigDrawer is a
    real dialog (role/aria-modal/Escape/focus); real form labels; focus-visible rings; "Handle it"→"Dismiss"; post-connect
    CTA to Settings→Sources. Session log: `docs/sessions/session-2026-06-10-ui-a11y-pass.md`.
- **Global Connections refactor (2026-06-10, Fable 5): DONE, uncommitted.** Build + 44/44 tests green.
  Connections are now GLOBAL (workspace-level), not per-project — fixes the "select a project to view
  connections" gate. Two-layer model that prevents cross-project data mixing:
  • **`connections`** (new global table, migration `0004`) — one row per connected account: source +
    encrypted token + account metadata (Atlassian baseUrl/email). Plus **`global_settings`** for the
    workspace-level **Claude key** (`ANTHROPIC_API_KEY` moved here; reporting reads it globally).
  • **Per-project sources** = `integration_credentials` rows, now with a nullable **`connection_id`**
    (migration `0005`) pointing at a global connection; they hold the **resource scope** (github owner/repo,
    jira projectKey, confluence spaceKey=Space *ID*, notion databaseId) and a COPY of the connection's
    ciphertext token (re-propagated on rotation; detached on connection delete). SCHEMA_VERSION → **1.6.0**.
  • **Sync** merges connection account-meta + per-project scope (app layer; sync-engine untouched, still
    purges/keys cache by credentialId+projectId) → each project fetches only its slice → Claude only ever
    classifies one project's cache. No mixing by construction.
  • **UI**: Connections page (sidebar) is now global (no project needed) — manages the Claude key + tool
    accounts. New **Settings → Sources** tab binds a global connection to the current project + its scope.
  • Migrations `0004`+`0005` are additive (CREATE TABLE + ADD COLUMN) → auto-apply safely at next launch.
- **Connectors-UX + Gantt (2026-06-10, built on Fable 5 via subagents): DONE, uncommitted.**
  Verified on Kali: production build compiles (1570 modules), `pnpm --filter @creare/desktop typecheck`
  clean, `pnpm test` 44/44.
  1. **No login gate** — `ProtectedRoute` auto signs-in a local user (dev-stub); `/auth` kept as fallback.
  2. **New "Connections" hub** (sidebar, Plug icon → `/connections`, `pages/connections/ConnectionsPage.tsx`):
     one place for the Claude/Anthropic API key + every connector's credentials, with the CORRECT
     per-tool fields (Jira/Confluence: baseUrl+email+token → `metadata`; Notion: token+databaseId;
     GitHub: token+optional owner/repo; OneDrive: token). Settings trimmed to the Project tab;
     dashboard onboarding now links to /connections. (Named "Connections" because "Tools" nav = Tool Registry.)
  3. **Gantt/Timeline** — `tasks` gained `startDate`/`dueDate` (migration `0003_daily_impossible_man`,
     **SCHEMA_VERSION → 1.4.0**); `createTask`/`updateTask` + orchestration routes carry the dates;
     new `listEdges(projectId)` + aggregate `GET /projects/:id/timeline` ({tasks,edges,sprints,milestones}).
     UI: `pages/boards/TimelineTab.tsx` (new **Timeline** tab in Boards) — custom SVG/CSS Gantt: task bars,
     sprint bands, milestone diamonds, dependency arrows, a today line, inline date editing, and a
     per-task **focus mode** (BFS dependency chain). Create-task form (AgentsPage) gained start/due inputs.
  - NOTE: agent EXECUTION still intentionally not built — "Delegate" still just creates a `[Agent]`-labelled
    task (per decision 2026-06-10). Claude is used for planning/classification only.
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
  `pnpm run typecheck`.
- **better-sqlite3 ABI swap is now AUTOMATIC** (2026-06-10) — no more manual rebuild before `pnpm test`.
  The single native `.node` can only hold one ABI: Node (vitest) or Electron (app/E2E). Whichever
  ran last used to win, so tests broke after launching the app (`NODE_MODULE_VERSION 123 vs 127`).
  Fix: `scripts/rebuild-better-sqlite3.mjs ensure <node|electron>` keeps a per-platform-arch cache
  in `.sqlite-abi/` + a `build/Release/.abi-target` marker, and swaps via instant file copy (~0.03s)
  instead of a ~15s recompile. Wired so it just works: vitest `globalSetup` → `ensure node` (covers
  test/test:watch/test:coverage); root `predev` + desktop `predev`/`pree2e` → `ensure electron`;
  desktop `pretest` → `ensure node`. First build of each ABI still compiles once, then it's cached.
  `rebuild:sqlite:node|electron` still force a fresh build. **`.sqlite-abi/` is gitignored.**
  ✅ VERIFIED on Kali 2026-06-10: `pnpm test` auto-swapped (`already built for node — nothing to do`)
  and ran **44/44 green**.
- `migration 0002` snapshot — ✅ DONE (regenerated; `meta/0002_snapshot.json` present).
- The Linux-compiled `better-sqlite3` `.node` lives under stignored `node_modules` (no Mac clobber);
  the Mac builds + caches its own ABIs on first `ensure` (cache files are platform-arch-tagged, so a
  synced Kali cache is ignored on the Mac rather than loaded).

- **Desktop app now LAUNCHES on Kali** (2026-06-10, `pnpm dev`). Two pre-existing blockers fixed
  (neither related to the better-sqlite3 ABI work — uncovered while verifying the launch):
  1. `turbo run dev` had 12 persistent tasks (11 package `tsc --watch` + the app) vs. default
     concurrency 10 → aborted before launch. Fixed: `"concurrency": "16"` in `turbo.json`.
  2. `apps/desktop/package.json` `"main"` was `dist/main/index.js`, but electron-vite outputs to
     `out/`. Fixed: `"main": "out/main/index.js"`.
  Verified: Electron window opens, Fastify API up on `127.0.0.1:4321`, renderer renders and drives
  the API (sign-in, /projects, /notifications, /events/stream SSE). The `atom_cache.cc` stderr line
  is a benign Electron-on-X11 warning.

## DESKTOP LAUNCHER (day-to-day, 2026-06-10) — Linux only, Mac-safe
- `pnpm dev` now self-installs an app-menu + Desktop icon on first run (`predev` →
  `scripts/install-desktop-entry.mjs`, idempotent, **Linux-only** — no-ops on macOS).
- The icon runs `scripts/launch-creare.sh` → `electron-vite preview` (production build, no
  dev server). It `ensure electron`'s the ABI first and builds `out/` if missing. Logs to
  `~/.cache/creare-launch.log`. Refresh after code changes: `pnpm --filter @creare/desktop build`.
- App icon lives in `apps/desktop/resources/` (NOT `build/` — `.stignore` ignores `build/`, so
  it would never sync to the Mac). `.sqlite-abi/` added to `.stignore` (per-platform binaries).
- Mac equivalent (Dock `.app`/`.dmg` via electron-builder) is NOT built yet — future option.

## RESUME HERE (next step, in order)
Phase 3 + Phase 4 are committed and verified green on Kali. This session's changes
(ABI auto-swap, app-launch fixes, desktop launcher) are **uncommitted**. Remaining:
1. On the **Mac**: pull/sync, `pnpm install`, re-run `pnpm run typecheck` + `pnpm test` for
   parity. The first `pnpm test`/`pnpm dev` auto-builds the Mac's own native `better-sqlite3`
   ABI (no manual `node-gyp` step). Approve per-project hooks on first open. Desktop-icon
   install no-ops on macOS — launch via `pnpm dev` there.
2. Then the FOLLOW-UPS below.

## FOLLOW-UPS (after green build)
- Test suites for observability / integrations / reporting domains.
- Playwright E2E. ✅ FIXED + VERIFIED 2026-06-10: vitest no longer collects
  `apps/desktop/e2e/smoke.spec.ts` (added `**/e2e/**` to vitest `exclude`); those specs are
  Playwright-owned, run via `pnpm e2e`. Clean run: **11 files / 44 tests pass, no failed suite.**
- Routes + UI for eval and memory packages.

---
*Conventions: synchronous `getDb()` domain APIs; append-only `events` log on every
mutation; UUIDs via `generateId()`; no `any`; `exactOptionalPropertyTypes`.*
*On "done for the day", update this file's STATUS NOW / RESUME HERE and the
auto-memory pointer ([[project-creare]]).*
