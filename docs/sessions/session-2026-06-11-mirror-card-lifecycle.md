# Session Log — 2026-06-11 — Bidirectional card lifecycle (create/edit/close/comment push)

## What Was Done
- Added four outbox enqueue helpers to `packages/integrations/src/mirror/outbox.ts` (never throw; opId | null, null = not mirrored):
  - `enqueueItemUpdate(boardItemId, {title?, body?})` → `update_item` op against the item's remote link
  - `enqueueItemClose(boardItemId)` → `close_item`
  - `enqueueItemComment(boardItemId, body)` → `comment`
  - `enqueueItemCreate(boardItemId, title, body?)` → `create_item` against the BOARD link's container ref; payload JSON carries `localBoardItemId` (no remote_links row exists yet)
- Create-result linking in `processOp`: on a successful `create_item` push, the connector's `MutationResult.ref` (minted remote id) is UPSERTed into `remote_links` for the local board_item (remoteId + remoteVersion + containerRemoteId = board remote id, per the item-link convention), guarded so a link-write failure can never resurrect an already-applied op (duplicate-create hazard).
- New `apps/desktop/src/main/routes/mirror-cards.ts` (all requireAuth + assertProjectAccess + board/item ownership guards):
  - `POST /projects/:id/boards/:boardId/cards` — createTask(type 'human') + addBoardItem (first column when columnId omitted); enqueueItemCreate + kickPushWorker if mirrored; returns the board_item
  - `PATCH .../cards/:itemId` — local task title update + event; enqueueItemUpdate + kick
  - `POST .../cards/:itemId/close` — updateTask status 'completed'; enqueueItemClose + kick
  - `POST .../cards/:itemId/comment` — push-only; 400 when body empty, board unmirrored, or item not yet linked remotely
- Registered `mirrorCardsRoutes` after `mirrorsRoutes` in `apps/desktop/src/main/server.ts`; exported the new helpers from `packages/integrations/src/index.ts`.
- 9 new tests in `outbox.test.ts` (22/22 green): null-when-unmirrored for all helpers, op payload shapes, create payload carrying localBoardItemId, drain-success linking (incl. follow-up edit resolving with the new merge base), and upsert-not-duplicate when a pull linked the item mid-flight.

## Decisions Made
- `localBoardItemId` rides inside the op payload JSON (typed `CreateItemOp & { localBoardItemId: string }`) — no schema change; `mutation_queue.remoteLinkId` stays null for creates as the schema comment intends.
- Task-title PATCH writes the `tasks` row directly in the route (with append-only `task.updated` event): no domain API exposes title updates (agent-orchestration `updateTask` excludes title; @creare/boards has no task-title API) and this task's file-ownership scope forbade extending either domain package. Flagged as a candidate to lift into a domain API later.
- `enqueueItemCreate` resolves the board via a read of `board_items` (integrations reads boards tables; still only WRITES mutation_queue/remote_links).
- Comment route returns 400 (not 404) when the item has no remote link yet — board is mirrored but the create push hasn't landed.

## Files Created or Modified
- `packages/integrations/src/mirror/outbox.ts` (helpers + processOp linking)
- `packages/integrations/src/mirror/outbox.test.ts` (+9 tests)
- `packages/integrations/src/index.ts` (exports)
- `apps/desktop/src/main/routes/mirror-cards.ts` (NEW)
- `apps/desktop/src/main/server.ts` (registration)

## Open Questions
- Should task-title updates become a proper domain API (boards or agent-orchestration) so the route's direct `tasks` write can be removed?
- Close currently pushes `close_item` only — it does not also move the local item to a terminal column; remote pull will reconcile status.

## Next Session Should Start With
- `pnpm --filter @creare/integrations build && pnpm --filter @creare/integrations typecheck && pnpm --filter @creare/desktop typecheck && pnpm vitest run packages/integrations/src/mirror/outbox.test.ts` (all green as of this session, lint also clean). Consider renderer UI wiring for the four card routes.
