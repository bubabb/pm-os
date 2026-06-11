# Session Log — 2026-06-11 — Mirror engine deepreview correctness fixes

## What Was Done
- Reconciler: divergence detection now includes `failed`/`conflicted` ops (`UNRESOLVED_OP_STATUSES`, exported) — a failed push stays a CONFLICT, never silently reverted by remote-wins.
- Reconciler: tombstoned item links are no longer indexed as live — a snapshot item whose only link is a tombstone lands in `newItems` (boards resurrect path revives it). Remote-delete sweep already skipped tombstones (idempotent, unchanged).
- outbox.enqueueBoardItemMove: never throws. Unmirrored item → null; mirrored item with an unresolvable ref (unlinked column / missing board link / null statusField) → inserts a `'failed'` mutation_queue row with clear `lastError` (new `enqueueFailedBoardItemMove` helper) + `integration.mutation.failed` event; whole body wrapped in a last-resort try/catch → null.
- outbox: added `recoverStaleInFlight()` — resets `in_flight` → `pending`, returns count; exported from package index (push-worker already imports it).
- mirror-sync.pullMirror: queries ops with `UNRESOLVED_OP_STATUSES`; persists each plan conflict as a `sync_conflicts` row (mutationId null, remoteSnapshot = snapshot item JSON, base/local = link last-known values + pendingOpId), at most one OPEN row per link.
- mirror-sync.getMirrorStatus: added `failedPushes` (count of `'failed'` mutation_queue rows on this board's item links); all existing fields kept.
- Tests: updated reconciler.test.ts (unresolved-status conflicts, tombstone resurrection) and outbox.test.ts (failed-row enqueue paths, recoverStaleInFlight); created mirror-sync.test.ts (import, conflict persistence + idempotency, clean update, status counters) with a mocked GitHubProjectsClient and real boards.applyMirrorSnapshot.

## Decisions Made
- `UNRESOLVED_OP_STATUSES` exported from reconciler so mirror-sync's pull query stays in lockstep with the pure planner.
- Failed-enqueue rows store a diagnostic payload `{ kind: 'move_item', boardItemId, toColumnId }` — not a deliverable MutationOp; drain never selects `'failed'` so it can't reach a connector.
- `pendingPushes` remains pending/in_flight only; failures surface via the new `failedPushes` field.

## Files Created or Modified
- packages/integrations/src/mirror/reconciler.ts
- packages/integrations/src/mirror/outbox.ts
- packages/integrations/src/mirror/mirror-sync.ts
- packages/integrations/src/mirror/reconciler.test.ts
- packages/integrations/src/mirror/outbox.test.ts
- packages/integrations/src/mirror/mirror-sync.test.ts (new)
- packages/integrations/src/index.ts (export recoverStaleInFlight)

## Open Questions
- MirrorStatusChip (renderer) does not yet display `failedPushes` — desktop-owning agent should wire it.

## Next Session Should Start With
- Verify the chip renders failedPushes; consider a resolve-conflict UI consuming the now-persisted sync_conflicts rows.
