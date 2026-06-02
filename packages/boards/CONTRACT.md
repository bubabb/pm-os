# Boards — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-02
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
```

## Dependencies
- `@creare/database` — read/write boards, board_columns, board_items, sprints, milestones, milestone_tasks, events
- `@creare/shared` — `generateId()`
- `@creare/agent-orchestration` — reads task status to sync board item state

## Consumed By
- `apps/desktop` — all board and planning views
- `@creare/reporting` — sprint velocity, milestone completion data
