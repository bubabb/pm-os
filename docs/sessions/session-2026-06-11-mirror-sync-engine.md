# Session Log — 2026-06-11 — Mirror pull/import engine (integrations)

## What Was Done
- Implemented `packages/integrations/src/mirror/mirror-sync.ts` (NEW) — the impure pull orchestrator for bidirectional sync Phase 1:
  - `createMirror(credential, token, remoteProjectId)` — initial import: fetch ProjectV2 snapshot via `GitHubProjectsClient`, build `MirrorApply` (boardId=null, all columns, all items, no deletes), call `boards.applyMirrorSnapshot()`.
  - `pullMirror(credential, token, boardId)` — incremental pull: resolve board link → snapshot → `planReconcile(snapshot, links, pendingOps)` → apply newItems + remoteUpdates + remoteDeletes; conflicts are skipped and counted only; stamps `lastPulledAt` on touched links.
  - `getMirrorStatus(boardId)` — `{ linked, source, remoteUrl, lastPulledAt, pendingPushes, openConflicts }`; unlinked board returns `linked:false` with zeros, never errors.
- Emits `mirror.pull.started/completed/failed` events (sync-engine.ts pattern); connector errors propagate after the failed event.
- Added `@pm-os/boards` workspace dep to `packages/integrations/package.json` (integrations→boards, allowed direction) + lockfile update.

## Decisions Made
- Link scoping per board via `remote_links.containerRemoteId = board.remoteId` (applyMirrorSnapshot stamps it on item AND column links) — prevents cross-board false "remote deletes" when one credential mirrors several projects.
- `columnSyncHash()` is the single hash encoding shared with the reconciler/boards for column links.
- pendingPushes counts only mutations with a remoteLinkId (Phase 1 = moves, always linked); creates are unattributable pre-link.
- Conflicts are NOT written to sync_conflicts here — pull only counts; push-side policy owns conflict rows.

## Files Created or Modified
- `packages/integrations/src/mirror/mirror-sync.ts` (new)
- `packages/integrations/package.json` (+@pm-os/boards)
- `pnpm-lock.yaml` (install)

## Verification
- `pnpm --filter @pm-os/integrations typecheck` — green (after `pnpm --filter @pm-os/boards build` so the new dist types resolve).
- `pnpm --filter @pm-os/integrations lint` — green.

## Open Questions
- Whether pull-side conflicts should eventually persist to `sync_conflicts` (Phase 2 conflict UI will need rows; currently only counted).

## Next Session Should Start With
- Wire `routes/mirrors.ts` to these three functions (route resolves token via secrets layer) and `mirror/outbox.ts` + push-worker per the Phase 1 build order.
