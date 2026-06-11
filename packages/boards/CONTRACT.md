# Boards — Interface Contract
---
status: active
version: 1.1
last-updated: 2026-06-11
---

## Schema Types Consumed
From `@creare/database`:
```typescript
import type {
  Board, NewBoard,
  BoardColumn, NewBoardColumn,
  BoardItem, NewBoardItem,
  Sprint, NewSprint,
  Milestone, NewMilestone,
  MilestoneTask,
  Event, NewEvent,
} from '@creare/database'
```

## Events Emitted to Event Log
All events use `domain: 'boards'`.

| Event Type | Trigger | Payload |
|---|---|---|
| `board.item.moved` | Item moved to new column | `{ boardItemId, fromColumnId, toColumnId, taskId }` |
| `board.item.removed` | Mirrored item deleted remotely → removed locally (per item, actorType `system`) | `{ boardItemId, taskId, columnId, source, remoteId }` |
| `board.mirror.created` | Board created from a remote snapshot import | `{ source, remoteId, name }` |
| `board.mirror.synced` | Remote snapshot re-applied to an existing board | `{ source, remoteId, upserted, deleted }` |
| `task.created` | `applyMirrorSnapshot` creates the backing task for a mirrored item (actorType `system`) | `{ title, status, source, remoteId }` |
| `task.updated` | `applyMirrorSnapshot` changes a mirrored task's title/status (actorType `system`) | `{ changed, from: { title, status }, to: { title, status }, source, remoteId }` |
| `sprint.started` | Sprint moved to active | `{ sprintId, boardId, startDate }` |
| `sprint.completed` | Sprint completed | `{ sprintId, velocity, completedAt }` |
| `milestone.status_changed` | Milestone status updated | `{ milestoneId, from, to }` |

## Public API (finalized in Phase 2 Task #10)
```typescript
// Boards
createBoard(input: NewBoard): Promise<Board>
addColumn(input: NewBoardColumn): Promise<BoardColumn>
moveItem(boardItemId: string, toColumnId: string, position: number): Promise<BoardItem>
linkTaskToBoard(boardId: string, taskId: string, columnId: string): Promise<BoardItem>

// Sprints
createSprint(input: NewSprint): Promise<Sprint>
startSprint(sprintId: string): Promise<Sprint>
completeSprint(sprintId: string): Promise<Sprint>

// Milestones
createMilestone(input: NewMilestone): Promise<Milestone>
linkTaskToMilestone(milestoneId: string, taskId: string): Promise<void>

// Mirror sync — apply a remote snapshot (plain-data instruction defined in boards
// so @creare/integrations can depend on boards without a circular import).
// Writes boards, board_columns, board_items, tasks, and remote_links in ONE transaction.
applyMirrorSnapshot(apply: MirrorApply): { boardId: string }
```

### MirrorApply shapes (defined and exported by `@creare/boards`)
```typescript
interface MirrorApplyColumn { remoteId: string; name: string; position: number; isTerminal: boolean; syncHash: string }
interface MirrorApplyItem {
  remoteId: string; title: string; url: string | null
  columnRemoteId: string | null   // null = first/no-status column
  state: string; version: string; contentHash: string
}
interface MirrorApply {
  projectId: string
  credentialId: string
  source: string
  boardId: string | null          // null = CREATE the board (initial import)
  board: { remoteId: string; title: string; url: string | null; version: string; statusFieldRemoteId: string | null }
  columns: MirrorApplyColumn[]    // full desired column set (ordered by position)
  upsertItems: MirrorApplyItem[]  // create-or-update these items
  deleteRemoteIds: string[]       // remote item ids removed remotely → board_item removed, task kept, link tombstoned (deletedAt)
}
```

### Remote-link guarantees (mirror correctness)
- Column/item link lookups are **scoped by `containerRemoteId`** (the ProjectV2 node
  id = `board.remoteId`) — one credential mirroring several projects never resolves
  another board's links, even when remote ids collide (GitHub's default status-option
  ids are identical across projects).
- **Local deletes tombstone their links**: `removeBoardItem`, `deleteColumn`, and
  `deleteBoard` (board + its column/item links) set `remote_links.deletedAt` so the
  next pull recreates the entity instead of writing into a deleted local id.
- **Column-miss safety**: if a column link points at a column that no longer exists
  locally, `applyMirrorSnapshot` recreates the column and repoints the link — items
  are never placed into a nonexistent `columnId`.

## Dependencies
- `@creare/database` — read/write boards, board_columns, board_items, sprints, milestones, milestone_tasks, events; `applyMirrorSnapshot` additionally writes **tasks** (backing task per mirrored item) and **remote_links** (identity map, localType `board` / `board_column` / `board_item`)
- `@creare/shared` — `generateId()`
- `@creare/agent-orchestration` — reads task status to sync board item state

## Consumed By
- `apps/desktop` — all board and planning views
- `@creare/reporting` — sprint velocity, milestone completion data
