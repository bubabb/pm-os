import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedTask, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, remoteLinks, tasks, events } from '@creare/database'
import { eq, and } from 'drizzle-orm'
import {
  createBoard, listColumns, getColumn, updateColumn,
  createSprint, startSprint, getActiveSprint,
  addBoardItem, listBoardItems, removeBoardItem, moveBoardItem,
  applyMirrorSnapshot, getBoard, deleteBoard, deleteColumn,
} from './index'
import type { MirrorApply } from './index'

let userId: string
let projectId: string

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
})
afterEach(() => destroyTestDb())

describe('boards', () => {
  it('seeds default columns for a kanban board', () => {
    const board = createBoard(projectId, { name: 'Dev', type: 'kanban' }, userId)
    const cols = listColumns(board.id)
    expect(cols.length).toBe(4)
    expect(cols.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Review', 'Done'])
    expect(cols[cols.length - 1]?.isTerminal).toBe(true)
  })

  it('seeds the scrum column set for a scrum board', () => {
    const board = createBoard(projectId, { name: 'Scrum', type: 'scrum' }, userId)
    expect(listColumns(board.id)).toHaveLength(5)
  })

  it('updateColumn changes only the provided fields', () => {
    const board = createBoard(projectId, { name: 'b', type: 'kanban' }, userId)
    const col = listColumns(board.id)[0]!
    const updated = updateColumn(col.id, { name: 'Renamed' })
    expect(updated?.name).toBe('Renamed')
    expect(updated?.position).toBe(col.position) // untouched
    expect(getColumn(col.id)?.name).toBe('Renamed')
  })

  it('enforces a single active sprint per project', () => {
    const board = createBoard(projectId, { name: 'b', type: 'scrum' }, userId)
    const s1 = createSprint(board.id, projectId, { name: 'Sprint 1' }, userId)
    const s2 = createSprint(board.id, projectId, { name: 'Sprint 2' }, userId)

    expect(startSprint(s1.id, userId)?.status).toBe('active')
    // a second start must be refused while one is active
    expect(startSprint(s2.id, userId)).toBeNull()
    expect(getActiveSprint(projectId)?.id).toBe(s1.id)
  })

  it('adds a board item joined to its task title', () => {
    const board = createBoard(projectId, { name: 'b', type: 'kanban' }, userId)
    const col = listColumns(board.id)[0]!
    const taskId = seedTask(projectId, 'Implement X')
    const item = addBoardItem(board.id, col.id, taskId, { storyPoints: 3 })
    expect(item.storyPoints).toBe(3)
    const items = listBoardItems(board.id)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskTitle).toBe('Implement X')
  })
})

describe('applyMirrorSnapshot', () => {
  let credentialId: string

  beforeEach(() => {
    credentialId = seedCredential(projectId, 'github')
  })

  // A representative remote snapshot: two status columns, one open + one closed item.
  function makeApply(over?: Partial<MirrorApply>): MirrorApply {
    return {
      projectId,
      credentialId,
      source: 'github',
      boardId: null,
      board: { remoteId: 'PVT_1', title: 'Roadmap', url: 'https://github.com/orgs/x/projects/1', version: 'v1', statusFieldRemoteId: 'FIELD_STATUS' },
      columns: [
        { remoteId: 'opt-todo', name: 'Todo', position: 0, isTerminal: false, syncHash: 'h-todo' },
        { remoteId: 'opt-done', name: 'Done', position: 1, isTerminal: true, syncHash: 'h-done' },
      ],
      upsertItems: [
        { remoteId: 'itm-1', title: 'Fix login', url: 'https://github.com/x/y/issues/1', columnRemoteId: 'opt-todo', state: 'open', version: 'iv1', contentHash: 'c1' },
        { remoteId: 'itm-2', title: 'Ship docs', url: null, columnRemoteId: null, state: 'closed', version: 'iv1', contentHash: 'c2' },
      ],
      deleteRemoteIds: [],
      ...over,
    }
  }

  function allLinks() {
    return getDb().select().from(remoteLinks).where(eq(remoteLinks.credentialId, credentialId)).all()
  }

  function itemLink(remoteId: string) {
    const [l] = getDb().select().from(remoteLinks)
      .where(and(eq(remoteLinks.credentialId, credentialId), eq(remoteLinks.localType, 'board_item'), eq(remoteLinks.remoteId, remoteId)))
      .limit(1).all()
    return l ?? null
  }

  it('initial import creates the board, columns, items, tasks, and remote links', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())

    expect(getBoard(boardId)?.name).toBe('Roadmap')

    const cols = listColumns(boardId)
    expect(cols.map((c) => c.name)).toEqual(['Todo', 'Done'])
    expect(cols[1]?.isTerminal).toBe(true)

    const items = listBoardItems(boardId)
    expect(items).toHaveLength(2)
    // itm-1 lands in its mapped column; itm-2 (no status) falls back to the first column
    const fix = items.find((i) => i.taskTitle === 'Fix login')!
    const ship = items.find((i) => i.taskTitle === 'Ship docs')!
    expect(fix.columnId).toBe(cols[0]?.id)
    expect(ship.columnId).toBe(cols[0]?.id)

    // closed remote state → completed task
    const shipTask = getDb().select().from(tasks).where(eq(tasks.id, ship.taskId)).all()[0]!
    expect(shipTask.status).toBe('completed')

    // 1 board + 2 column + 2 item links, with hashes recorded
    const links = allLinks()
    expect(links).toHaveLength(5)
    const boardLink = links.find((l) => l.localType === 'board')
    expect(boardLink?.remoteId).toBe('PVT_1')
    // board link stores the Status FIELD id in containerRemoteId
    expect(boardLink?.containerRemoteId).toBe('FIELD_STATUS')
    // column + item links store the ProjectV2 node id in containerRemoteId
    expect(links.find((l) => l.remoteId === 'opt-todo')?.lastSyncedHash).toBe('h-todo')
    expect(links.find((l) => l.remoteId === 'opt-todo')?.containerRemoteId).toBe('PVT_1')
    expect(itemLink('itm-1')?.lastSyncedHash).toBe('c1')
    expect(itemLink('itm-1')?.containerRemoteId).toBe('PVT_1')
  })

  it('re-applying an unchanged snapshot is idempotent', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const { boardId: again } = applyMirrorSnapshot(makeApply({ boardId }))

    expect(again).toBe(boardId)
    expect(listColumns(boardId)).toHaveLength(2)
    expect(listBoardItems(boardId)).toHaveLength(2)
    expect(allLinks()).toHaveLength(5)
    expect(getDb().select().from(tasks).where(eq(tasks.projectId, projectId)).all()).toHaveLength(2)
  })

  it('moves an item when its remote column changes', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const moved = makeApply({ boardId })
    moved.upsertItems[0]!.columnRemoteId = 'opt-done'
    moved.upsertItems[0]!.contentHash = 'c1b'
    applyMirrorSnapshot(moved)

    const doneCol = listColumns(boardId).find((c) => c.name === 'Done')!
    const fix = listBoardItems(boardId).find((i) => i.taskTitle === 'Fix login')!
    expect(fix.columnId).toBe(doneCol.id)
    expect(itemLink('itm-1')?.lastSyncedHash).toBe('c1b')
  })

  it('deletes the board item but keeps the task and tombstones the link', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    applyMirrorSnapshot(makeApply({
      boardId,
      upsertItems: [makeApply().upsertItems[1]!], // itm-2 survives
      deleteRemoteIds: ['itm-1'],
    }))

    const items = listBoardItems(boardId)
    expect(items).toHaveLength(1)
    expect(items[0]?.taskTitle).toBe('Ship docs')
    // task history is preserved
    expect(getDb().select().from(tasks).where(eq(tasks.projectId, projectId)).all()).toHaveLength(2)
    // link soft-deleted, not removed
    const link = itemLink('itm-1')
    expect(link).not.toBeNull()
    expect(link?.deletedAt).not.toBeNull()
  })

  it('creates newly added columns on a later sync', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const withExtra = makeApply({ boardId })
    withExtra.columns.push({ remoteId: 'opt-review', name: 'Review', position: 2, isTerminal: false, syncHash: 'h-review' })
    applyMirrorSnapshot(withExtra)

    const cols = listColumns(boardId)
    expect(cols.map((c) => c.name)).toEqual(['Todo', 'Done', 'Review'])
    expect(allLinks().filter((l) => l.localType === 'board_column')).toHaveLength(3)
  })

  // ── Event-log coverage for mirrored task writes (append-only rule) ─────────

  function eventsOfType(type: string) {
    return getDb().select().from(events)
      .where(and(eq(events.projectId, projectId), eq(events.type, type)))
      .all()
  }

  it('emits task.created for every mirrored task it creates', () => {
    applyMirrorSnapshot(makeApply())
    const created = eventsOfType('task.created')
    expect(created).toHaveLength(2)
    expect(created.every((e) => e.actorType === 'system' && e.domain === 'boards')).toBe(true)
    const payloads = created.map((e) => JSON.parse(e.payload ?? '{}') as { title: string; remoteId: string })
    expect(payloads.map((p) => p.title).sort()).toEqual(['Fix login', 'Ship docs'])
  })

  it('emits task.updated when a mirrored task title/status changes', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const changedSnap = makeApply({ boardId })
    changedSnap.upsertItems[0]!.title = 'Fix login (renamed)'
    changedSnap.upsertItems[0]!.state = 'closed'
    changedSnap.upsertItems[0]!.contentHash = 'c1b'
    applyMirrorSnapshot(changedSnap)

    const updated = eventsOfType('task.updated')
    expect(updated).toHaveLength(1)
    const payload = JSON.parse(updated[0]!.payload ?? '{}') as { changed: string[]; remoteId: string }
    expect(payload.changed.sort()).toEqual(['status', 'title'])
    expect(payload.remoteId).toBe('itm-1')
    // unchanged items emit nothing
    applyMirrorSnapshot(makeApply({ boardId }))
  })

  it('emits a per-item board.item.removed when a mirrored item is deleted', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    applyMirrorSnapshot(makeApply({
      boardId,
      upsertItems: [makeApply().upsertItems[1]!],
      deleteRemoteIds: ['itm-1'],
    }))

    const removed = eventsOfType('board.item.removed')
    expect(removed).toHaveLength(1)
    const payload = JSON.parse(removed[0]!.payload ?? '{}') as { remoteId: string; boardItemId: string }
    expect(payload.remoteId).toBe('itm-1')
    expect(removed[0]!.resourceId).toBe(payload.boardItemId)
  })

  // ── Local deletes tombstone their remote links ─────────────────────────────

  it('removeBoardItem tombstones the item remote link', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const fix = listBoardItems(boardId).find((i) => i.taskTitle === 'Fix login')!
    expect(itemLink('itm-1')?.deletedAt).toBeNull()

    removeBoardItem(fix.id)
    expect(itemLink('itm-1')?.deletedAt).not.toBeNull()
  })

  it('deleteColumn tombstones the column remote link', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const done = listColumns(boardId).find((c) => c.name === 'Done')! // empty — FK allows deletion
    deleteColumn(done.id)
    const colLink = allLinks().find((l) => l.localType === 'board_column' && l.remoteId === 'opt-done')
    expect(colLink?.deletedAt).not.toBeNull()
  })

  it('deleteBoard tombstones the board link and all of its column/item links', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    deleteBoard(boardId)
    const links = allLinks()
    expect(links).toHaveLength(5) // links are kept (identity for late echoes), never hard-deleted
    expect(links.every((l) => l.deletedAt !== null)).toBe(true)
  })

  // ── containerRemoteId scoping (one credential, several remote projects) ────

  it('does not cross-wire columns when one credential mirrors two projects with identical option ids', () => {
    const { boardId: boardA } = applyMirrorSnapshot(makeApply())

    // Second ProjectV2 under the SAME credential — GitHub default status-option
    // ids ('opt-todo'/'opt-done' here) are identical across projects.
    const { boardId: boardB } = applyMirrorSnapshot(makeApply({
      board: { remoteId: 'PVT_2', title: 'Roadmap B', url: null, version: 'v1', statusFieldRemoteId: 'FIELD_STATUS_B' },
      upsertItems: [
        { remoteId: 'itm-b1', title: 'B work', url: null, columnRemoteId: 'opt-todo', state: 'open', version: 'iv1', contentHash: 'cb1' },
      ],
    }))

    expect(boardB).not.toBe(boardA)
    const colsA = listColumns(boardA)
    const colsB = listColumns(boardB)
    // Board B got its OWN columns — not wired into board A's
    expect(colsB.map((c) => c.name)).toEqual(['Todo', 'Done'])
    expect(colsA.map((c) => c.id)).not.toContain(colsB[0]!.id)

    // B's item landed on B's board, in B's Todo column
    const itemsB = listBoardItems(boardB)
    expect(itemsB).toHaveLength(1)
    expect(itemsB[0]!.columnId).toBe(colsB.find((c) => c.name === 'Todo')!.id)
    // and board A is untouched
    expect(listBoardItems(boardA)).toHaveLength(2)

    // Each board's column links are scoped by its own ProjectV2 id
    const todoLinks = allLinks().filter((l) => l.localType === 'board_column' && l.remoteId === 'opt-todo')
    expect(todoLinks.map((l) => l.containerRemoteId).sort()).toEqual(['PVT_1', 'PVT_2'])

    // A re-sync of board A still resolves A's own columns (no cross-wire on update either)
    applyMirrorSnapshot(makeApply({ boardId: boardA }))
    expect(listColumns(boardA).map((c) => c.id).sort()).toEqual(colsA.map((c) => c.id).sort())
  })

  // ── Column-miss safety ─────────────────────────────────────────────────────

  it('recreates a locally deleted mirrored column on the next pull instead of using a dead id', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const cols0 = listColumns(boardId)
    const oldTodo = cols0.find((c) => c.name === 'Todo')!
    const done = cols0.find((c) => c.name === 'Done')!
    // Empty the column locally (FK blocks deleting a column that holds items), then delete it.
    for (const item of listBoardItems(boardId)) moveBoardItem(item.id, done.id)
    deleteColumn(oldTodo.id)

    applyMirrorSnapshot(makeApply({ boardId }))

    const cols = listColumns(boardId)
    expect(cols.map((c) => c.name)).toEqual(['Todo', 'Done'])
    const newTodo = cols.find((c) => c.name === 'Todo')!
    expect(newTodo.id).not.toBe(oldTodo.id)

    // No item points at a nonexistent column, and Todo items live in the recreated column
    const items = listBoardItems(boardId)
    expect(items).toHaveLength(2)
    for (const item of items) expect(getColumn(item.columnId)).not.toBeNull()
    expect(items.find((i) => i.taskTitle === 'Fix login')!.columnId).toBe(newTodo.id)

    // the column link was repointed and resurrected, not duplicated
    const todoLinks = allLinks().filter((l) => l.localType === 'board_column' && l.remoteId === 'opt-todo')
    expect(todoLinks).toHaveLength(1)
    expect(todoLinks[0]!.localId).toBe(newTodo.id)
    expect(todoLinks[0]!.deletedAt).toBeNull()
  })

  it('re-pulls a locally removed mirrored item (tombstoned link is resurrected)', () => {
    const { boardId } = applyMirrorSnapshot(makeApply())
    const fix = listBoardItems(boardId).find((i) => i.taskTitle === 'Fix login')!
    removeBoardItem(fix.id)
    expect(listBoardItems(boardId)).toHaveLength(1)

    applyMirrorSnapshot(makeApply({ boardId }))

    const items = listBoardItems(boardId)
    expect(items).toHaveLength(2)
    const link = itemLink('itm-1')
    expect(link?.deletedAt).toBeNull()
    expect(link?.localId).not.toBe(fix.id)
  })
})
