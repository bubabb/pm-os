import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedTask, destroyTestDb } from '@creare/database/testing'
import {
  createBoard, listColumns, getColumn, updateColumn,
  createSprint, startSprint, getActiveSprint,
  addBoardItem, listBoardItems,
} from './index'

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
