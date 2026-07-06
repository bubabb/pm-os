# Session Log — 2026-06-08 — Phase 3 — Domain 2: Tool Registry

## Context
Resumed Phase 3. Prior commits (`8d8e74a`, `3bebe8a`) had already landed Settings, Domain 1
(Agent Orchestration), Domain 4 (Boards), and Domain 3 (Observability) — ahead of the
phase3-start session doc. Working tree was clean. Next item in the Phase 3 order was
**Task 5: Domain 2 — Tool Registry** (`packages/tool-registry` was still a 3-line stub).

## What Was Done

### Domain implementation — `packages/tool-registry/src/index.ts`
Replaced the stub with the full synchronous domain API (matching boards / agent-orchestration):
- **Tools:** `listTools`, `getTool`, `createTool` (emits `tool.created`)
- **Versions (immutable):** `listVersions`, `getToolVersion`, `publishVersion` (emits
  `tool.version.published`, repoints `tools.latestVersionId`)
- **Deployments (single active):** `listDeployments`, `getActiveDeployment`,
  `deploy` (emits `tool.deployed`), `rollback` (emits `tool.rolled_back`)
- Rollback is additive — a new active deployment pointing at the prior version, never a delete.
- Added `drizzle-orm: ^0.45.2` to `packages/tool-registry/package.json`.

### Desktop wiring
- `apps/desktop/src/main/routes/tools.ts` — NEW; full REST surface for tools/versions/deployments,
  actor id from `user.id`, 400 on domain validation errors. Registered in `server.ts`.
- `apps/desktop/src/renderer/pages/tools/ToolsPage.tsx` — NEW; master-detail registry UI
  (tool list + create, active-deployment banner + rollback, version list + per-version deploy,
  publish-version form with JSON validation, deployment history). TanStack Query + inline Tailwind.
- `App.tsx` — replaced `<Placeholder title="Tool Registry" />` with `<ToolsPage />`; removed the
  now-unused `Placeholder` import (every route is a real page now).

### Docs / protocol
- `CONTRACT.md` → v1.1 (synchronous signatures + explicit `actorId`; documents added discovery fns).
- Handoff: `agent-state/handoffs/phase3-tool-registry-output.md`
- `agent-state/domain-state/tool-registry.md` and `agent-state/agent-log.md` updated.

## Decisions
- **Single active deployment invariant:** deploy supersedes the prior active (→ `rolled_back`) and
  records its version as `previousVersionId` so rollback can restore it. Rollback chains stay
  coherent by recovering the restored version's own previous from deployment history.
- **`latestVersionId` = newest published**, independent of what is deployed.
- Followed the real synchronous `getDb()` convention over the CONTRACT's original `Promise` shape.

## Known Issues / Outstanding
- **TypeScript not verified.** This session ran on the Linux (Kali) peer, which has no
  `node_modules` / `pnpm`, and cross-package types resolve via built `dist/*.d.ts`. A full
  install+build is additionally blocked by a syncthing hazard: the Pm.Os Project folder has **no
  `.stignore`**, so a Linux `node_modules` would be advertised to the Mac and could clobber its
  macOS-native modules (better-sqlite3, esbuild).
- **Action on the Mac before committing as complete:**
  ```
  pnpm install
  pnpm --filter @pm-os/tool-registry exec tsc --noEmit
  pnpm --filter @pm-os/desktop exec tsc --noEmit
  ```
- Recommend adding a `.stignore` (node_modules/, dist/, .turbo/, .DS_Store, .git/) to the synced
  folder so the two machines don't fight over build artifacts.

## Next Session
- Verify tsc on Mac, then commit Domain 2.
- Phase 3 Task 6: Real OAuth (GitHub + Entra browser-window flow).
- Phase 3 Task 7: Background sync scheduler (Electron setInterval in main process).
