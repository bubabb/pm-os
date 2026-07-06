# Session Log — 2026-06-09 — Phase 3 Review + Fixes

## Context
After implementing Domain 2 (Tool Registry), ran a full review of **all of Phase 3** (Settings,
Domain 1 Agent Orchestration, Domain 3 Observability, Domain 4 Boards, Domain 2 Tool Registry +
cross-cutting wiring) via 5 parallel domain reviewers, verified the falsifiable findings against
source, then applied the complete fix set. ~24 files changed.

## Fixes Applied

### P1 — correctness blockers
- **Milestone status crash (Boards UI):** `MilestoneStatus` type, `MILESTONE_STATUS_BADGE`, and the
  selectable `STATUSES` realigned to the DB enum (`pending | at_risk | completed | missed`). Previously
  the UI used `open | in_progress | …` → `undefined` badge lookups at runtime + invalid status writes.
- **`exactOptionalPropertyTypes` violations:** fixed `reviewerNote` in `AgentsPage`, and the same class
  in `observability` routes (event-log/audit-log option building, `createTrace` taskId). These would
  fail `tsc`. Boards/Observability were committed without ever being compiled.

### P2 — real bugs
- **`lastSyncedAt`** (`reporting/sprint-reader.ts`): `orderBy(fetchedAt)` → `orderBy(desc(fetchedAt))`.
- **Systemic IDOR:** added sub-resource ownership guards (`entity.projectId === :id`) across
  orchestration, boards, observability, and tools routes (workspace/task/board/sprint/milestone/trace/tool).
- **`sequenceNumber` race** (`observability.addTraceEvent`): atomic `MAX()+1` inside a transaction.
- **Tool deploy history:** added `superseded` to the `tool_deployments.status` enum (schema — additive)
  so a forward deploy no longer marks its predecessor `rolled_back`; UI badge added. `deploy()` updated.
- **`/deployments/active`** now returns `{ deployment: ToolDeployment | null }` (JSON-safe vs bare null).

### P3 — correctness/quality
- **Append-only completeness:** `updateWorkspaceStatus`/`terminateWorkspace` now emit events
  (`agent.workspace.status_changed` / `agent.workspace.terminated`); `updateTask` emits `task.updated`
  for non-status edits; `task.created` payload now includes `taskId`/`projectId`;
  `resolveApprovalGate` emits the contract's `approval.gate.resolved`; `milestone.status_changed`
  carries `{ milestoneId, from, to }`. `actorId` threaded through all boards mutations.
- **Lifecycle integrity:** `updateSprint` no longer accepts `status` (must go through start/complete);
  single-active-sprint guard and DAG cycle-detection are now transactional; `createApprovalGate`
  rejects orphan gates; `addEdge` validates both endpoints belong to the project.
- **N+1 queries:** `listTraces` and `listBoardItems` rewritten with a `LEFT JOIN`.
- **`deleteBoard`** cascades to columns/sprints/items (FK enforcement not assumed); `createBoard`
  is transactional.
- **Settings UI:** archive / sync / secret-delete now surface errors (no stuck spinners / silent fails).
- **Missing route:** added `POST /projects/:id/audit-log`; clamped `limit` query params.

### Discarded (verified false positive)
- `classifyItems(events, ctx.apiKey)` in `reporting.ts` is **correct** — the integrations `CONTRACT.md`
  is stale (actual signature is `(rows, apiKey)`). No change.

### Contracts
- `agent-orchestration/CONTRACT.md`: documented new workspace/task events.
- `tool-registry/CONTRACT.md`: documented `superseded` status + active-deployment response shape.
- `packages/database/src/schema.ts`: added `superseded` to `tool_deployments.status` (additive, coordinated).

## NOT done / verification pending
- **`tsc --noEmit` and `vitest run` not run** — this session ran on the Linux peer (no node_modules /
  pnpm; cross-package types need built `dist/`). Ran cross-file consistency greps instead.
- Likely first-compile fixups to watch: drizzle `.transaction()` return-type inference (boards
  `startSprint` returns a boolean from the tx callback), `getTableColumns` spread typing in the
  rewritten joins. The previously-uncompiled boards/observability code may surface a few more
  `exactOptional` issues.

## On the Mac before committing
```
pnpm install
pnpm -r exec tsc --noEmit     # or per-package: @pm-os/<domain> and @pm-os/desktop
pnpm -r test                  # vitest
```
Then commit (no Co-Authored-By):
```
feat(phase3): Domain 2 Tool Registry + Phase 3 review fixes (events, IDOR guards, races, UI)
```

## Next
- Phase 3 Task 6: Real OAuth (GitHub + Entra). Task 7: background sync scheduler.
