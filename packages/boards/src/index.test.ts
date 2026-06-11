import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedTask, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, remoteLinks, tasks } from '@creare/database'
import { eq, and } from 'drizzle-orm'
import {
  createBoard, listColumns, getColumn, updateColumn,
  createSprint, startSprint, getActiveSprint,
  addBoardItem, listBoardItems,
  applyMirrorSnapshot, getBoard,
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
})
