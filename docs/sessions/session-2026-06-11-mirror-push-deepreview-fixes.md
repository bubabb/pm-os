# Session Log — 2026-06-11 — Mirror routes + push worker deepreview fixes

## What Was Done
- **boards.ts (P0 silent-revert):** Item-move PATCH now AWAITS `enqueueBoardItemMove` (new contract: never throws, returns opId|null) so a tracked mutation_queue row exists before the 200 response; `kickPushWorker()` on non-null opId. A pull can no longer silently revert an un-tracked move.
- **mirrors.ts (P0 duplicate import):** `POST /projects/:id/mirrors` now checks `remote_links` (localType='board', remoteId, projectId, deletedAt IS NULL) BEFORE creating a credential → `409 { error, boardId }` with the existing board. Also: if `createMirror` throws after `storeIntegrationCredential`, the orphaned credential row is deleted via `deleteIntegrationCredential` (cleanup .catch-guarded) before the 502.
- **push-worker.ts (P0/P1):** `startPushWorker` boot now awaits `recoverStaleInFlight()` (in_flight→pending after a crash) before starting the interval; logs count if >0; `started` flag keeps idempotency through the async boot, `stopPushWorker` resets it. After each drain, if failed/conflicts >0, `notifyPushProblems(sinceIso)` queries mutation_queue rows that flipped to failed/conflicted during the drain, groups per project, resolves `projects.ownerId`, and fire-and-forgets `createNotification` (type 'agent_failed' for failures / 'mention' for conflicts-only, resourceType 'mutation_queue').

## Decisions Made
- Coded to the parallel-change contract: `recoverStaleInFlight(): Promise<number>` exported from `@creare/integrations` — NOT YET LANDED in packages/integrations at session end. Verified via temporary dist .d.ts shim: my three files typecheck clean once the export exists.
- Failure detection uses updatedAt >= drain-start timestamp (drain result has no per-op detail) — terminal states only, so each parked op notifies once.

## Files Created or Modified
- apps/desktop/src/main/routes/boards.ts
- apps/desktop/src/main/routes/mirrors.ts
- apps/desktop/src/main/sync/push-worker.ts

## Open Questions
- `pnpm --filter @creare/desktop typecheck` runs `tsc --noEmit` on a solution tsconfig with `files: []` + references — it checks NOTHING (vacuously green). Direct `tsc --noEmit -p tsconfig.node.json` reveals 3 pre-existing errors in connections.ts / secrets-service.ts / server.ts (not touched here). The typecheck script should probably be `tsc -b --noEmit` or per-reference.
- Desktop typecheck will fail with `TS2305: no exported member 'recoverStaleInFlight'` until the parallel outbox change lands.

## Next Session Should Start With
Confirm the integrations outbox change (never-throw enqueueBoardItemMove + recoverStaleInFlight export) landed, rebuild integrations, re-run desktop typecheck.
