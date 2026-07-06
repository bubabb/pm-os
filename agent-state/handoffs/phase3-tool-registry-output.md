# Handoff: Phase 3 — Domain 2: Tool Registry

**Status:** Implementation complete — TypeScript NOT yet verified (see Verification)
**Completed:** 2026-06-08

## What Was Built

### @pm-os/tool-registry — Domain 2
Replaced the 3-line stub `packages/tool-registry/src/index.ts` with the full domain implementation:

- **Tool management**
  - `listTools(projectId)` — all tools in a project
  - `getTool(id)` — single tool or null
  - `createTool(projectId, params, createdById)` — registers a tool; emits `tool.created`
- **Version management** (immutable — never overwritten)
  - `listVersions(toolId)` — newest-first
  - `getToolVersion(versionId)` — single version or null
  - `publishVersion(toolId, params, publishedById)` — new immutable version, repoints `tools.latestVersionId`; emits `tool.version.published`
- **Deployment management** (single active per tool)
  - `listDeployments(toolId)` — newest-first history
  - `getActiveDeployment(toolId)` — the one active deployment or null
  - `deploy(toolId, versionId, deployedById)` — supersedes prior active, records `previousVersionId`; emits `tool.deployed`
  - `rollback(toolId, deployedById)` — new active deployment pointing at the prior version (never destructive); emits `tool.rolled_back`
- Added `drizzle-orm: ^0.45.2` to `packages/tool-registry/package.json`

All mutations write to the append-only `events` log with `domain: 'tool-registry'`.

### Desktop app
- `apps/desktop/src/main/routes/tools.ts` — NEW. Routes:
  - `GET/POST /projects/:id/tools`, `GET /projects/:id/tools/:toolId`
  - `GET/POST /projects/:id/tools/:toolId/versions`, `GET .../versions/:versionId`
  - `GET /projects/:id/tools/:toolId/deployments`, `GET .../deployments/active`
  - `POST /projects/:id/tools/:toolId/deploy` (body `{ versionId }`)
  - `POST /projects/:id/tools/:toolId/rollback`
  - Actor id sourced from `user.id`; deploy/publish/rollback wrapped to return 400 on domain validation errors.
- Registered `toolsRoutes` in `apps/desktop/src/main/server.ts`
- `apps/desktop/src/renderer/pages/tools/ToolsPage.tsx` — NEW. Master-detail registry: tool list + create, per-tool active-deployment banner with rollback, versions list with per-version deploy, publish-version form (with JSON validation), deployment history. TanStack Query + inline Tailwind, matches AgentsPage/BoardsPage patterns.
- Wired into `App.tsx`: replaced `<Placeholder title="Tool Registry" />` with `<ToolsPage />`; removed now-unused `Placeholder` import (all routes are real pages).

## Key Design Decisions
- **Single active deployment invariant:** deploying a new version sets the prior active deployment to `rolled_back` and stores its version as `previousVersionId`, so `rollback()` can restore it.
- **Rollback is never destructive** — it creates a *new* active deployment pointing at the old version (per domain CLAUDE.md).
- **`latestVersionId`** tracks newest *published* version, independent of what is *deployed*.
- Rollback chains: the restored deployment's `previousVersionId` is recovered from the last time that version was deployed, so repeated rollbacks stay coherent.

## API change vs CONTRACT.md (v1 → v1.1)
The original CONTRACT (Phase 2 planning) specified `Promise`-returning signatures. The actual codebase domains (boards, agent-orchestration) are **synchronous** (`getDb()` better-sqlite3). This domain follows the real synchronous convention and adds an explicit `actorId` parameter for create/publish/deploy/rollback (the NOT-NULL `*ById` columns). CONTRACT.md updated to match.

## Verification — OUTSTANDING
`tsc --noEmit` was **not** run. This box (Kali) has no `node_modules`, no `pnpm`, and packages are unbuilt (cross-package types resolve via each package's `dist/*.d.ts`). A full install+build is also blocked by a syncthing hazard: the Pm.Os Project folder currently has **no `.stignore`**, so installing Linux-native `node_modules` here would advertise them to the Mac.

**Run on the Mac before committing as complete:**
```
pnpm install        # picks up new drizzle-orm dep in tool-registry
pnpm --filter @pm-os/tool-registry exec tsc --noEmit
pnpm --filter @pm-os/desktop exec tsc --noEmit
```
Manual review covered: exactOptionalPropertyTypes (fixed 2 explicit-undefined assignments in ToolsPage), noUncheckedIndexedAccess, unused imports, drizzle import surface.

## Next (remaining Phase 3)
- Task 6: Real OAuth — GitHub + Entra browser-window flow
- Task 7: Background sync scheduler — Electron setInterval in main process
