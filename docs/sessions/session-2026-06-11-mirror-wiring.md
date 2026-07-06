# Session Log — 2026-06-11 — Wire bidirectional-sync engine into the app

## What Was Done
- Re-exported the mirror public API from `packages/integrations/src/index.ts`: `createMirror`, `pullMirror`, `getMirrorStatus` (+ `MirrorStatus` type), `enqueueMutation`, `enqueueBoardItemMove`, `drainMutationQueue` (+ `DrainResult` type), and `GitHubConnector` (needed by the remote-board picker route; Phase 1 mirrors are GitHub-only).
- NEW `apps/desktop/src/main/routes/mirrors.ts` with four routes (all requireAuth; project routes also assertProjectAccess):
  - `GET /connections/:connectionId/remote-boards` — GitHubConnector.listRemoteBoards via getConnectionToken; 404 unknown connection, 502 upstream failure.
  - `POST /projects/:id/mirrors` — storeIntegrationCredential (token copy from connection, metadata `{ projectV2Id: remoteId }`), emits `integration.credential.created`, resolves token (getIntegrationToken + withMergedConnectionMetadata), createMirror → `{ boardId }`; 502 on error.
  - `POST /projects/:id/boards/:boardId/pull` — remote_links lookup (localType 'board') → credential row → token → pullMirror → `{ pulled, conflicts }`; 404 if not mirrored / wrong project; 502 upstream.
  - `GET /projects/:id/boards/:boardId/sync-status` — getMirrorStatus(boardId).
- MODIFIED `routes/boards.ts` item-move PATCH: after successful moveBoardItem, fire-and-forget `enqueueBoardItemMove(itemId, columnId).then(opId => opId && kickPushWorker()).catch(log)` — never blocks/fails the response.
- NEW `apps/desktop/src/main/sync/push-worker.ts`: `startPushWorker(intervalMs?)` (default 5s, `PMOS_PUSH_INTERVAL_MS` override, 0 disables), `kickPushWorker()` (250ms debounced immediate drain), `stopPushWorker()`. Single-flight drain guard with one queued follow-up pass; getCredential resolves credential row + plaintext token via secrets layer.
- Registered `mirrorsRoutes` in `server.ts` (after boardsRoutes); `startPushWorker()` in `index.ts` whenReady (after startSyncScheduler), `stopPushWorker()` on window-all-closed.

## Decisions Made
- `GitHubConnector` re-exported from the integrations index despite the "connectors stay internal" note — the desktop app resolves the package via `dist/index.d.ts` (no deep imports), and the remote-board picker needs `listRemoteBoards()`. Scoped comment added.
- Pull route 404s when the board link exists but belongs to a different project (cross-project guard, matching boards.ts ownership-guard style).
- Push worker queues exactly one follow-up drain when kicked mid-drain, so ops enqueued during a pass are never stranded until the next tick.

## Files Created or Modified
- `packages/integrations/src/index.ts` (modified — re-exports)
- `apps/desktop/src/main/routes/mirrors.ts` (new)
- `apps/desktop/src/main/routes/boards.ts` (modified — push hook)
- `apps/desktop/src/main/sync/push-worker.ts` (new)
- `apps/desktop/src/main/server.ts` (modified — route registration)
- `apps/desktop/src/main/index.ts` (modified — worker start/stop)

## Open Questions
- Renderer UI (MirrorStatusChip, mirror-source picker) not wired in this session — routes are ready.
- No automated route tests for mirrors.ts yet (mirror/outbox engine has its own unit tests).

## Next Session Should Start With
- Build the renderer surface for mirrors (remote-board picker + sync-status chip + pull button), then E2E the move→push path against a live GitHub ProjectV2.

## Verification
- `pnpm --filter @pm-os/integrations typecheck` ✅, `build` ✅
- `pnpm --filter @pm-os/desktop typecheck` ✅
- `eslint src` clean on both packages ✅
