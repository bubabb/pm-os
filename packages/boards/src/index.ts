import {
  getDb, boards, boardColumns, sprints, boardItems, milestones, milestoneTasks, tasks, events,
} from '@creare/database'
import { eq, and, asc, ne, desc } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import type { InferSelectModel } from 'drizzle-orm'

// ── Re-exported types ─────────────────────────────────────────────────────────

export type Board         = InferSelectModel<typeof boards>
export type BoardColumn   = InferSelectModel<typeof boardColumns>
export type Sprint        = InferSelectModel<typeof sprints>
export type BoardItem     = InferSelectModel<typeof boardItems>
export type Milestone     = InferSelectModel<typeof milestones>
export type MilestoneTask = InferSelectModel<typeof milestoneTasks>

// ── Board management ──────────────────────────────────────────────────────────

export interface CreateBoardParams {
  name: string
  type?: Board['type']
}

export function listBoards(projectId: string): Board[] {
  return getDb().select().from(boards).where(eq(boards.projectId, projectId)).all()
}

export function getBoard(id: string): Board | null {
  const [b] = getDb().select().from(boards).where(eq(boards.id, id)).limit(1).all()
  return b ?? null
}

export function createBoard(projectId: string, params: CreateBoardParams): Board {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(boards).values({
    id, projectId, name: params.name, type: params.type ?? 'kanban', createdAt: now, updatedAt: now,
  }).run()

  // Seed default columns based on board type
  const defaults = params.type === 'scrum'
    ? [
        { name: 'Backlog',     position: 0, isTerminal: false },
        { name: 'In Sprint',   position: 1, isTerminal: false },
        { name: 'In Progress', position: 2, isTerminal: false },
        { name: 'Review',      position: 3, isTerminal: false },
        { name: 'Done',        position: 4, isTerminal: true },
      ]
    : [
        { name: 'To Do',       position: 0, isTerminal: false },
        { name: 'In Progress', position: 1, isTerminal: false },
        { name: 'Review',      position: 2, isTerminal: false },
        { name: 'Done',        position: 3, isTerminal: true },
      ]

  for (const col of defaults) {
    createColumn(id, col)
  }

  _logEvent(projectId, 'board.created', 'boards', 'user', null, 'board', id, { name: params.name, type: params.type ?? 'kanban' })
  return getBoard(id)!
}

export function deleteBoard(id: string): void {
  const board = getBoard(id)
  if (!board) return
  getDb().delete(boards).where(eq(boards.id, id)).run()
  _logEvent(board.projectId, 'board.deleted', 'boards', 'user', null, 'board', id, {})
}

// ── Column management ─────────────────────────────────────────────────────────

export interface CreateColumnParams {
  name: string
  position: number
  isTerminal?: boolean
  wipLimit?: number
}

export function listColumns(boardId: string): BoardColumn[] {
  return getDb()
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(asc(boardColumns.position))
    .all()
}

export function createColumn(boardId: string, params: CreateColumnParams): BoardColumn {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(boardColumns).values({
    id, boardId,
    name: params.name,
    position: params.position,
    isTerminal: params.isTerminal ?? false,
    wipLimit: params.wipLimit ?? null,
    createdAt: now,
    updatedAt: now,
  }).run()
  return getDb().select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1).all()[0]!
}

export function updateColumn(
  id: string,
  update: Partial<Pick<BoardColumn, 'name' | 'position' | 'isTerminal' | 'wipLimit'>>,
): BoardColumn | null {
  const now = new Date().toISOString()
  getDb().update(boardColumns).set({ ...update, updatedAt: now }).where(eq(boardColumns.id, id)).run()
  const [col] = getDb().select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1).all()
  return col ?? null
}

export function deleteColumn(id: string): void {
  getDb().delete(boardColumns).where(eq(boardColumns.id, id)).run()
}

// ── Sprint management ─────────────────────────────────────────────────────────

export interface CreateSprintParams {
  name: string
  goal?: string
  startDate?: string
  endDate?: string
}

export function listSprints(projectId: string, opts?: { status?: Sprint['status'] }): Sprint[] {
  const db = getDb()
  if (opts?.status) {
    return db.select().from(sprints)
      .where(and(eq(sprints.projectId, projectId), eq(sprints.status, opts.status)))
      .orderBy(desc(sprints.createdAt))
      .all()
  }
  return db.select().from(sprints)
    .where(eq(sprints.projectId, projectId))
    .orderBy(desc(sprints.createdAt))
    .all()
}

export function getActiveSprint(projectId: string): Sprint | null {
  const [s] = getDb().select().from(sprints)
    .where(and(eq(sprints.projectId, projectId), eq(sprints.status, 'active')))
    .limit(1)
    .all()
  return s ?? null
}

export function createSprint(boardId: string, projectId: string, params: CreateSprintParams): Sprint {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(sprints).values({
    id, boardId, projectId,
    name: params.name,
    goal: params.goal ?? null,
    status: 'planning',
    startDate: params.startDate ?? null,
    endDate: params.endDate ?? null,
    velocity: null,
    createdAt: now,
    updatedAt: now,
  }).run()
  _logEvent(projectId, 'sprint.created', 'boards', 'user', null, 'sprint', id, { name: params.name })
  return getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()[0]!
}

export function updateSprint(
  id: string,
  update: Partial<Pick<Sprint, 'name' | 'goal' | 'status' | 'startDate' | 'endDate' | 'velocity'>>,
): Sprint | null {
  const now = new Date().toISOString()
  getDb().update(sprints).set({ ...update, updatedAt: now }).where(eq(sprints.id, id)).run()
  const [s] = getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()
  return s ?? null
}

// Completes a sprint: marks it completed, activates any 'planning' sprint on the same board.
export function completeSprint(id: string): Sprint | null {
  const [sprint] = getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()
  if (!sprint || sprint.status !== 'active') return null

  const now = new Date().toISOString()
  getDb().update(sprints).set({ status: 'completed', updatedAt: now }).where(eq(sprints.id, id)).run()

  _logEvent(sprint.projectId, 'sprint.completed', 'boards', 'user', null, 'sprint', id, {})
  return getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()[0] ?? null
}

export function startSprint(id: string): Sprint | null {
  const [sprint] = getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()
  if (!sprint || sprint.status !== 'planning') return null

  // Ensure no other active sprint in this project
  const db = getDb()
  const [existing] = db.select().from(sprints)
    .where(and(eq(sprints.projectId, sprint.projectId), eq(sprints.status, 'active')))
    .limit(1).all()
  if (existing) return null  // caller must complete existing sprint first

  const now = new Date().toISOString()
  const startDate = sprint.startDate ?? now.split('T')[0]!
  db.update(sprints).set({ status: 'active', startDate, updatedAt: now }).where(eq(sprints.id, id)).run()

  _logEvent(sprint.projectId, 'sprint.started', 'boards', 'user', null, 'sprint', id, {})
  return db.select().from(sprints).where(eq(sprints.id, id)).limit(1).all()[0] ?? null
}

// ── Board items ───────────────────────────────────────────────────────────────

export interface AddBoardItemParams {
  storyPoints?: number
  sprintId?: string
  position?: number
}

export function listBoardItems(boardId: string, opts?: { sprintId?: string }): (BoardItem & { taskTitle: string | null })[] {
  const db = getDb()
  const items = db.select().from(boardItems)
    .where(
      opts?.sprintId
        ? and(eq(boardItems.boardId, boardId), eq(boardItems.sprintId, opts.sprintId))
        : eq(boardItems.boardId, boardId),
    )
    .orderBy(asc(boardItems.position))
    .all()

  return items.map((item) => {
    const [task] = db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, item.taskId)).limit(1).all()
    return { ...item, taskTitle: task?.title ?? null }
  })
}

export function addBoardItem(boardId: string, columnId: string, taskId: string, params?: AddBoardItemParams): BoardItem {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(boardItems).values({
    id, boardId, columnId, taskId,
    sprintId: params?.sprintId ?? null,
    storyPoints: params?.storyPoints ?? null,
    position: params?.position ?? 0,
    createdAt: now,
    updatedAt: now,
  }).run()
  return getDb().select().from(boardItems).where(eq(boardItems.id, id)).limit(1).all()[0]!
}

export function moveBoardItem(
  itemId: string,
  columnId: string,
  sprintId?: string | null,
): BoardItem | null {
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { columnId, updatedAt: now }
  if (sprintId !== undefined) patch['sprintId'] = sprintId
  getDb().update(boardItems).set(patch).where(eq(boardItems.id, itemId)).run()
  const [item] = getDb().select().from(boardItems).where(eq(boardItems.id, itemId)).limit(1).all()
  return item ?? null
}

export function removeBoardItem(itemId: string): void {
  getDb().delete(boardItems).where(eq(boardItems.id, itemId)).run()
}

// ── Milestones ────────────────────────────────────────────────────────────────

export interface CreateMilestoneParams {
  title: string
  description?: string
  dueDate?: string
}

export function listMilestones(projectId: string, opts?: { status?: Milestone['status'] | 'open' }): Milestone[] {
  const db = getDb()
  if (!opts?.status) {
    return db.select().from(milestones).where(eq(milestones.projectId, projectId)).all()
  }
  if (opts.status === 'open') {
    return db.select().from(milestones)
      .where(and(eq(milestones.projectId, projectId), ne(milestones.status, 'completed')))
      .all()
  }
  return db.select().from(milestones)
    .where(and(eq(milestones.projectId, projectId), eq(milestones.status, opts.status)))
    .all()
}

export function getMilestone(id: string): Milestone | null {
  const [m] = getDb().select().from(milestones).where(eq(milestones.id, id)).limit(1).all()
  return m ?? null
}

export function createMilestone(projectId: string, params: CreateMilestoneParams): Milestone {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(milestones).values({
    id, projectId,
    title: params.title,
    description: params.description ?? null,
    dueDate: params.dueDate ?? null,
    status: 'pending',
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run()
  _logEvent(projectId, 'milestone.created', 'boards', 'user', null, 'milestone', id, { title: params.title })
  return getDb().select().from(milestones).where(eq(milestones.id, id)).limit(1).all()[0]!
}

export function updateMilestone(
  id: string,
  update: Partial<Pick<Milestone, 'title' | 'description' | 'dueDate' | 'status'>>,
): Milestone | null {
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { ...update, updatedAt: now }
  if (update.status === 'completed') patch['completedAt'] = now
  getDb().update(milestones).set(patch).where(eq(milestones.id, id)).run()
  const [m] = getDb().select().from(milestones).where(eq(milestones.id, id)).limit(1).all()
  if (m) _logEvent(m.projectId, 'milestone.updated', 'boards', 'user', null, 'milestone', id, { status: update.status })
  return m ?? null
}

export function addMilestoneTask(milestoneId: string, taskId: string): MilestoneTask {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(milestoneTasks).values({ id, milestoneId, taskId, createdAt: now }).run()
  return getDb().select().from(milestoneTasks).where(eq(milestoneTasks.id, id)).limit(1).all()[0]!
}

export function listMilestoneTasks(milestoneId: string): MilestoneTask[] {
  return getDb().select().from(milestoneTasks).where(eq(milestoneTasks.milestoneId, milestoneId)).all()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _logEvent(
  projectId: string,
  type: string,
  domain: string,
  actorType: 'user' | 'agent' | 'system',
  actorId: string | null,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
): void {
  getDb().insert(events).values({
    id: generateId(),
    type,
    domain,
    projectId,
    actorType,
    actorId,
    resourceType,
    resourceId,
    payload: JSON.stringify(payload),
  }).run()
}
