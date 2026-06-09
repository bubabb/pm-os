# Domain State: Boards
**Status:** Implemented (Phase 3) + review fixes applied — tsc pending on Mac
**Last updated:** 2026-06-09

## Implemented
- Boards/columns, sprints, board items, milestones — `packages/boards/src/index.ts`
- Routes: `apps/desktop/src/main/routes/boards.ts`; UI: `BoardsPage.tsx`

## Review fixes (2026-06-09)
- UI milestone status enum realigned to schema (`pending|at_risk|completed|missed`) — fixed runtime crash.
- `startSprint` single-active guard is transactional; `updateSprint` no longer mutates status (use start/complete).
- `milestone.status_changed` event with `{ milestoneId, from, to }`; `actorId` threaded through all mutations.
- `createBoard` transactional; `deleteBoard` cascades columns/sprints/items.
- `listBoardItems` N+1 → LEFT JOIN. Added `getSprint`. Routes: board/sprint/milestone ownership guards.

## Outstanding
- `tsc --noEmit` on Mac. Watch `getTableColumns` spread typing in `listBoardItems` and tx return typing.
