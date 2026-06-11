import {
  getDb, boards, boardColumns, sprints, boardItems, milestones, milestoneTasks, tasks, events, remoteLinks,
} from '@creare/database'
import { eq, and, asc, ne, desc, getTableColumns, inArray, isNull } from 'drizzle-orm'
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

export function createBoard(projectId: string, params: CreateBoardParams, actorId?: string): Board {
  const id = generateId()
  const now = new Date().toISOString()
  const type = params.type ?? 'kanban'

  // Seed default columns based on board type
  const defaults = type === 'scrum'
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

  // Board + its default columns are created atomically so a partial board can't exist.
  getDb().transaction(() => {
    getDb().insert(boards).values({ id, projectId, name: params.name, type, createdAt: now, updatedAt: now }).run()
    for (const col of defaults) createColumn(id, col)
  })

  _logEvent(projectId, 'board.created', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'board', id, { name: params.name, type })
  return getBoard(id)!
}

export function deleteBoard(id: string, actorId?: string): void {
  const board = getBoard(id)
  if (!board) return
  const now = new Date().toISOString()
  // Capture dependent ids BEFORE deleting so their remote links can be tombstoned.
  const columnIds = listColumns(id).map((c) => c.id)
  const itemIds = getDb().select().from(boardItems).where(eq(boardItems.boardId, id)).all().map((i) => i.id)
  // Cascade-delete dependent rows (SQLite FK enforcement is not assumed to be enabled).
  getDb().transaction(() => {
    getDb().delete(boardItems).where(eq(boardItems.boardId, id)).run()
    getDb().delete(boardColumns).where(eq(boardColumns.boardId, id)).run()
    getDb().delete(sprints).where(eq(sprints.boardId, id)).run()
    getDb().delete(boards).where(eq(boards.id, id)).run()
    // Tombstone the board's remote link AND its column/item links — a live link
    // would make the next mirror pull resolve into the deleted local rows.
    getDb().update(remoteLinks).set({ deletedAt: now, updatedAt: now })
      .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, id), isNull(remoteLinks.deletedAt))).run()
    if (columnIds.length > 0) {
      getDb().update(remoteLinks).set({ deletedAt: now, updatedAt: now })
        .where(and(eq(remoteLinks.localType, 'board_column'), inArray(remoteLinks.localId, columnIds), isNull(remoteLinks.deletedAt))).run()
    }
    if (itemIds.length > 0) {
      getDb().update(remoteLinks).set({ deletedAt: now, updatedAt: now })
        .where(and(eq(remoteLinks.localType, 'board_item'), inArray(remoteLinks.localId, itemIds), isNull(remoteLinks.deletedAt))).run()
    }
  })
  _logEvent(board.projectId, 'board.deleted', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'board', id, {})
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
  const board = getBoard(boardId)
  if (board) _logEvent(board.projectId, 'column.created', 'boards', 'system', null, 'column', id, { boardId, name: params.name })
  return getDb().select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1).all()[0]!
}

export function getColumn(id: string): BoardColumn | null {
  const [c] = getDb().select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1).all()
  return c ?? null
}

export function updateColumn(
  id: string,
  update: Partial<Pick<BoardColumn, 'name' | 'position' | 'isTerminal' | 'wipLimit'>>,
): BoardColumn | null {
  // Build the patch with explicit guards — spreading a Partial would pass `undefined`
  // for absent keys, which exactOptionalPropertyTypes rejects in Drizzle's .set().
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (update.name !== undefined) patch['name'] = update.name
  if (update.position !== undefined) patch['position'] = update.position
  if (update.isTerminal !== undefined) patch['isTerminal'] = update.isTerminal
  if (update.wipLimit !== undefined) patch['wipLimit'] = update.wipLimit
  getDb().update(boardColumns).set(patch).where(eq(boardColumns.id, id)).run()
  const [col] = getDb().select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1).all()
  if (col) {
    const board = getBoard(col.boardId)
    if (board) _logEvent(board.projectId, 'column.updated', 'boards', 'system', null, 'column', id, { changed: Object.keys(update) })
  }
  return col ?? null
}

export function deleteColumn(id: string): void {
  const col = getColumn(id)
  const now = new Date().toISOString()
  getDb().transaction(() => {
    getDb().delete(boardColumns).where(eq(boardColumns.id, id)).run()
    // Tombstone any remote link so the next mirror pull recreates the column
    // instead of mapping items into the deleted column id.
    getDb().update(remoteLinks).set({ deletedAt: now, updatedAt: now })
      .where(and(eq(remoteLinks.localType, 'board_column'), eq(remoteLinks.localId, id), isNull(remoteLinks.deletedAt))).run()
  })
  if (col) {
    const board = getBoard(col.boardId)
    if (board) _logEvent(board.projectId, 'column.deleted', 'boards', 'system', null, 'column', id, { boardId: col.boardId })
  }
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

export function getSprint(id: string): Sprint | null {
  const [s] = getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()
  return s ?? null
}

export function createSprint(boardId: string, projectId: string, params: CreateSprintParams, actorId?: string): Sprint {
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
  _logEvent(projectId, 'sprint.created', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'sprint', id, { name: params.name })
  return getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()[0]!
}

// Status is intentionally NOT updatable here — lifecycle transitions must go through
// startSprint / completeSprint so the single-active invariant and events are enforced.
export function updateSprint(
  id: string,
  update: Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate' | 'velocity'>>,
): Sprint | null {
  // Explicit-guard patch — see updateColumn for why a Partial spread is unsafe here.
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (update.name !== undefined) patch['name'] = update.name
  if (update.goal !== undefined) patch['goal'] = update.goal
  if (update.startDate !== undefined) patch['startDate'] = update.startDate
  if (update.endDate !== undefined) patch['endDate'] = update.endDate
  if (update.velocity !== undefined) patch['velocity'] = update.velocity
  getDb().update(sprints).set(patch).where(eq(sprints.id, id)).run()
  const [s] = getDb().select().from(sprints).where(eq(sprints.id, id)).limit(1).all()
  if (s) _logEvent(s.projectId, 'sprint.updated', 'boards', 'system', null, 'sprint', id, { changed: Object.keys(update) })
  return s ?? null
}

// Completes a sprint: marks it completed.
export function completeSprint(id: string, actorId?: string): Sprint | null {
  const sprint = getSprint(id)
  if (!sprint || sprint.status !== 'active') return null

  const now = new Date().toISOString()
  getDb().update(sprints).set({ status: 'completed', updatedAt: now }).where(eq(sprints.id, id)).run()

  _logEvent(sprint.projectId, 'sprint.completed', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'sprint', id, {})
  return getSprint(id)
}

export function startSprint(id: string, actorId?: string): Sprint | null {
  const sprint = getSprint(id)
  if (!sprint || sprint.status !== 'planning') return null

  const db = getDb()
  const now = new Date().toISOString()
  const startDate = sprint.startDate ?? now.split('T')[0]!

  // Atomically re-check the single-active invariant and activate, so two concurrent
  // start calls can't both produce an active sprint.
  const started = db.transaction((tx) => {
    const [existing] = tx.select().from(sprints)
      .where(and(eq(sprints.projectId, sprint.projectId), eq(sprints.status, 'active')))
      .limit(1).all()
    if (existing) return false  // caller must complete the existing sprint first
    tx.update(sprints).set({ status: 'active', startDate, updatedAt: now }).where(eq(sprints.id, id)).run()
    return true
  })
  if (!started) return null

  _logEvent(sprint.projectId, 'sprint.started', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'sprint', id, {})
  return getSprint(id)
}

// ── Board items ───────────────────────────────────────────────────────────────

export interface AddBoardItemParams {
  storyPoints?: number
  sprintId?: string
  position?: number
}

export function listBoardItems(boardId: string, opts?: { sprintId?: string }): (BoardItem & { taskTitle: string | null })[] {
  // Single LEFT JOIN to fetch task titles instead of one query per board item.
  return getDb()
    .select({ ...getTableColumns(boardItems), taskTitle: tasks.title })
    .from(boardItems)
    .leftJoin(tasks, eq(tasks.id, boardItems.taskId))
    .where(
      opts?.sprintId
        ? and(eq(boardItems.boardId, boardId), eq(boardItems.sprintId, opts.sprintId))
        : eq(boardItems.boardId, boardId),
    )
    .orderBy(asc(boardItems.position))
    .all()
}

export function getBoardItem(id: string): BoardItem | null {
  const [i] = getDb().select().from(boardItems).where(eq(boardItems.id, id)).limit(1).all()
  return i ?? null
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
  const board = getBoard(boardId)
  if (board) _logEvent(board.projectId, 'item.added', 'boards', 'system', null, 'item', id, { boardId, columnId, taskId })
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
  if (item) {
    const board = getBoard(item.boardId)
    if (board) _logEvent(board.projectId, 'item.moved', 'boards', 'system', null, 'item', itemId, { columnId, ...(sprintId !== undefined ? { sprintId } : {}) })
  }
  return item ?? null
}

export function removeBoardItem(itemId: string): void {
  const item = getBoardItem(itemId)
  const now = new Date().toISOString()
  getDb().transaction(() => {
    getDb().delete(boardItems).where(eq(boardItems.id, itemId)).run()
    // Tombstone any remote link — a live link would make the next mirror pull
    // write into the deleted board_item id (or never re-pull the item).
    getDb().update(remoteLinks).set({ deletedAt: now, updatedAt: now })
      .where(and(eq(remoteLinks.localType, 'board_item'), eq(remoteLinks.localId, itemId), isNull(remoteLinks.deletedAt))).run()
  })
  if (item) {
    const board = getBoard(item.boardId)
    if (board) _logEvent(board.projectId, 'item.removed', 'boards', 'system', null, 'item', itemId, { boardId: item.boardId })
  }
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

export function createMilestone(projectId: string, params: CreateMilestoneParams, actorId?: string): Milestone {
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
  _logEvent(projectId, 'milestone.created', 'boards', actorId ? 'user' : 'system', actorId ?? null, 'milestone', id, { title: params.title })
  return getDb().select().from(milestones).where(eq(milestones.id, id)).limit(1).all()[0]!
}

export function updateMilestone(
  id: string,
  update: Partial<Pick<Milestone, 'title' | 'description' | 'dueDate' | 'status'>>,
  actorId?: string,
): Milestone | null {
  const existing = getMilestone(id)
  if (!existing) return null

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { ...update, updatedAt: now }
  if (update.status === 'completed') patch['completedAt'] = now
  getDb().update(milestones).set(patch).where(eq(milestones.id, id)).run()
  const updated = getMilestone(id)

  const actorType = actorId ? 'user' : 'system'
  if (update.status !== undefined && update.status !== existing.status) {
    _logEvent(existing.projectId, 'milestone.status_changed', 'boards', actorType, actorId ?? null, 'milestone', id, { milestoneId: id, from: existing.status, to: update.status })
  } else {
    _logEvent(existing.projectId, 'milestone.updated', 'boards', actorType, actorId ?? null, 'milestone', id, { changed: Object.keys(update) })
  }
  return updated
}

export function addMilestoneTask(milestoneId: string, taskId: string): MilestoneTask {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(milestoneTasks).values({ id, milestoneId, taskId, createdAt: now }).run()
  const milestone = getMilestone(milestoneId)
  if (milestone) _logEvent(milestone.projectId, 'milestone.task_added', 'boards', 'system', null, 'milestone_task', id, { milestoneId, taskId })
  return getDb().select().from(milestoneTasks).where(eq(milestoneTasks.id, id)).limit(1).all()[0]!
}

export function listMilestoneTasks(milestoneId: string): MilestoneTask[] {
  return getDb().select().from(milestoneTasks).where(eq(milestoneTasks.milestoneId, milestoneId)).all()
}

// ── Mirror sync (apply a remote snapshot) ─────────────────────────────────────
//
// Plain-data instruction shapes defined HERE so the integrations mirror-sync
// layer can depend on boards without boards importing @creare/integrations
// (which would create a circular dependency). Integrations translates its
// ReconcilePlan into a MirrorApply and calls applyMirrorSnapshot.

export type RemoteLink = InferSelectModel<typeof remoteLinks>

export interface MirrorApplyColumn {
  remoteId: string
  name: string
  position: number
  isTerminal: boolean
  syncHash: string
}

export interface MirrorApplyItem {
  remoteId: string
  title: string
  url: string | null
  columnRemoteId: string | null // which column (status option) it belongs in; null = first/no-status column
  state: string
  version: string
  contentHash: string
}

export interface MirrorApply {
  projectId: string
  credentialId: string
  source: string
  boardId: string | null // null = CREATE the board (initial import)
  // Link conventions (must stay in sync with integrations/mirror/outbox.ts):
  //   board link:  containerRemoteId = the Status FIELD remote id (statusFieldRemoteId, may be null)
  //   column link: containerRemoteId = the ProjectV2 node id (board.remoteId)
  //   item link:   containerRemoteId = the ProjectV2 node id (board.remoteId)
  board: { remoteId: string; title: string; url: string | null; version: string; statusFieldRemoteId: string | null }
  columns: MirrorApplyColumn[] // full desired column set (ordered by position)
  upsertItems: MirrorApplyItem[] // create-or-update these items
  deleteRemoteIds: string[] // item remoteIds removed/archived remotely → remove locally
}

// `containerRemoteId` scopes the match to one remote container (the ProjectV2
// node id for column/item links). It is REQUIRED for board_column and
// board_item lookups: GitHub's default status-option ids (e.g. Todo) are
// identical across projects, so an unscoped match under a credential that
// mirrors several projects would cross-wire a column onto the wrong board.
function _findRemoteLink(
  credentialId: string,
  localType: RemoteLink['localType'],
  remoteType: string,
  remoteId: string,
  containerRemoteId?: string,
): RemoteLink | null {
  const conditions = [
    eq(remoteLinks.credentialId, credentialId),
    eq(remoteLinks.localType, localType),
    eq(remoteLinks.remoteType, remoteType),
    eq(remoteLinks.remoteId, remoteId),
  ]
  if (containerRemoteId !== undefined) conditions.push(eq(remoteLinks.containerRemoteId, containerRemoteId))
  const [link] = getDb().select().from(remoteLinks)
    .where(and(...conditions))
    .limit(1).all()
  return link ?? null
}

// Applies a full remote snapshot (board + columns + items) inside a single
// transaction, creating or reconciling local rows and their remote_links.
export function applyMirrorSnapshot(apply: MirrorApply): { boardId: string } {
  const db = getDb()
  const now = new Date().toISOString()
  const isImport = apply.boardId === null

  const boardId = db.transaction(() => {
    // ── Board ──────────────────────────────────────────────────────────────
    let localBoardId: string
    if (apply.boardId === null) {
      localBoardId = generateId()
      db.insert(boards).values({
        id: localBoardId,
        projectId: apply.projectId,
        name: apply.board.title,
        type: 'kanban',
        createdAt: now,
        updatedAt: now,
      }).run()
      db.insert(remoteLinks).values({
        id: generateId(),
        projectId: apply.projectId,
        credentialId: apply.credentialId,
        source: apply.source,
        localType: 'board',
        localId: localBoardId,
        remoteType: 'pv2_project',
        remoteId: apply.board.remoteId,
        // Board-link convention: containerRemoteId carries the Status FIELD
        // remote id (null when the remote project has no Status field).
        containerRemoteId: apply.board.statusFieldRemoteId,
        remoteUrl: apply.board.url,
        remoteVersion: apply.board.version,
        lastPulledAt: now,
        createdAt: now,
        updatedAt: now,
      }).run()
      _logEvent(apply.projectId, 'board.mirror.created', 'boards', 'system', null, 'board', localBoardId, {
        source: apply.source,
        remoteId: apply.board.remoteId,
        name: apply.board.title,
      })
    } else {
      localBoardId = apply.boardId
      // Keep the board link's Status FIELD id current (same convention as the
      // create path above) — the remote field id can change across pulls.
      const boardLink = _findRemoteLink(apply.credentialId, 'board', 'pv2_project', apply.board.remoteId)
      if (boardLink && boardLink.containerRemoteId !== apply.board.statusFieldRemoteId) {
        db.update(remoteLinks).set({
          containerRemoteId: apply.board.statusFieldRemoteId,
          updatedAt: now,
        }).where(eq(remoteLinks.id, boardLink.id)).run()
      }
    }

    // ── Columns ────────────────────────────────────────────────────────────
    // Ensure a local column (+ remote link) exists for every desired column.
    const columnIdByRemoteId = new Map<string, string>()
    for (const col of apply.columns) {
      const link = _findRemoteLink(apply.credentialId, 'board_column', 'pv2_status_option', col.remoteId, apply.board.remoteId)
      if (!link) {
        const created = createColumn(localBoardId, { name: col.name, position: col.position, isTerminal: col.isTerminal })
        db.insert(remoteLinks).values({
          id: generateId(),
          projectId: apply.projectId,
          credentialId: apply.credentialId,
          source: apply.source,
          localType: 'board_column',
          localId: created.id,
          remoteType: 'pv2_status_option',
          remoteId: col.remoteId,
          containerRemoteId: apply.board.remoteId,
          remoteVersion: apply.board.version,
          lastSyncedHash: col.syncHash,
          lastPulledAt: now,
          createdAt: now,
          updatedAt: now,
        }).run()
        columnIdByRemoteId.set(col.remoteId, created.id)
      } else {
        const existing = getColumn(link.localId)
        if (!existing) {
          // The link points at a column that no longer exists locally (e.g.
          // deleted via deleteColumn, which tombstones the link). RECREATE the
          // column and repoint the link — items must never be mapped into a
          // dead column id.
          const recreated = createColumn(localBoardId, { name: col.name, position: col.position, isTerminal: col.isTerminal })
          db.update(remoteLinks).set({
            localId: recreated.id,
            lastSyncedHash: col.syncHash,
            remoteVersion: apply.board.version,
            lastPulledAt: now,
            deletedAt: null,
            updatedAt: now,
          }).where(eq(remoteLinks.id, link.id)).run()
          columnIdByRemoteId.set(col.remoteId, recreated.id)
          continue
        }
        if (existing.name !== col.name || existing.position !== col.position || existing.isTerminal !== col.isTerminal) {
          updateColumn(existing.id, { name: col.name, position: col.position, isTerminal: col.isTerminal })
        }
        // Always record the latest remote state hash on the link.
        db.update(remoteLinks).set({
          lastSyncedHash: col.syncHash,
          remoteVersion: apply.board.version,
          lastPulledAt: now,
          updatedAt: now,
        }).where(eq(remoteLinks.id, link.id)).run()
        columnIdByRemoteId.set(col.remoteId, link.localId)
      }
    }

    // Fallback column for items with no status: the first desired column, or
    // (if the snapshot carries no columns) the board's first existing column.
    const fallbackColumnId: string | undefined =
      apply.columns.length > 0
        ? columnIdByRemoteId.get(apply.columns[0]!.remoteId)
        : listColumns(localBoardId)[0]?.id

    const resolveColumnId = (remoteColumnId: string | null): string => {
      const target = (remoteColumnId !== null ? columnIdByRemoteId.get(remoteColumnId) : undefined) ?? fallbackColumnId
      if (!target) throw new Error('applyMirrorSnapshot: no local column available to place items')
      return target
    }

    // ── Items (upsert) ─────────────────────────────────────────────────────
    for (const item of apply.upsertItems) {
      const link = _findRemoteLink(apply.credentialId, 'board_item', 'pv2_item', item.remoteId, apply.board.remoteId)
      const targetColumnId = resolveColumnId(item.columnRemoteId)
      const taskStatus = item.state === 'closed' ? 'completed' : 'pending'

      if (!link || link.deletedAt !== null) {
        // Create the backing task — board_items.taskId is NOT NULL.
        const taskId = generateId()
        db.insert(tasks).values({
          id: taskId,
          projectId: apply.projectId,
          title: item.title,
          type: 'human',
          status: taskStatus,
          createdAt: now,
          updatedAt: now,
        }).run()
        // Append-only event log: mirrored task writes are state changes too.
        _logEvent(apply.projectId, 'task.created', 'boards', 'system', null, 'task', taskId, {
          title: item.title,
          status: taskStatus,
          source: apply.source,
          remoteId: item.remoteId,
        })
        const boardItem = addBoardItem(localBoardId, targetColumnId, taskId)
        if (!link) {
          db.insert(remoteLinks).values({
            id: generateId(),
            projectId: apply.projectId,
            credentialId: apply.credentialId,
            source: apply.source,
            localType: 'board_item',
            localId: boardItem.id,
            remoteType: 'pv2_item',
            remoteId: item.remoteId,
            containerRemoteId: apply.board.remoteId,
            remoteUrl: item.url,
            remoteVersion: item.version,
            lastSyncedHash: item.contentHash,
            lastPulledAt: now,
            createdAt: now,
            updatedAt: now,
          }).run()
        } else {
          // Tombstoned link for an item that reappeared remotely — resurrect it.
          db.update(remoteLinks).set({
            localId: boardItem.id,
            remoteUrl: item.url,
            remoteVersion: item.version,
            lastSyncedHash: item.contentHash,
            lastPulledAt: now,
            deletedAt: null,
            updatedAt: now,
          }).where(eq(remoteLinks.id, link.id)).run()
        }
      } else {
        const boardItem = getBoardItem(link.localId)
        if (boardItem) {
          if (boardItem.columnId !== targetColumnId) {
            db.update(boardItems).set({ columnId: targetColumnId, updatedAt: now }).where(eq(boardItems.id, boardItem.id)).run()
            _logEvent(apply.projectId, 'board.item.moved', 'boards', 'system', null, 'item', boardItem.id, {
              boardItemId: boardItem.id,
              fromColumnId: boardItem.columnId,
              toColumnId: targetColumnId,
              taskId: boardItem.taskId,
            })
          }
          const [task] = db.select().from(tasks).where(eq(tasks.id, boardItem.taskId)).limit(1).all()
          if (task && (task.title !== item.title || task.status !== taskStatus)) {
            db.update(tasks).set({ title: item.title, status: taskStatus, updatedAt: now }).where(eq(tasks.id, task.id)).run()
            const changed: string[] = []
            if (task.title !== item.title) changed.push('title')
            if (task.status !== taskStatus) changed.push('status')
            _logEvent(apply.projectId, 'task.updated', 'boards', 'system', null, 'task', task.id, {
              changed,
              from: { title: task.title, status: task.status },
              to: { title: item.title, status: taskStatus },
              source: apply.source,
              remoteId: item.remoteId,
            })
          }
        }
        db.update(remoteLinks).set({
          remoteUrl: item.url,
          remoteVersion: item.version,
          lastSyncedHash: item.contentHash,
          lastPulledAt: now,
          updatedAt: now,
        }).where(eq(remoteLinks.id, link.id)).run()
      }
    }

    // ── Deletes ────────────────────────────────────────────────────────────
    // Remove the board_item, keep the task (history), tombstone the link.
    for (const remoteId of apply.deleteRemoteIds) {
      const link = _findRemoteLink(apply.credentialId, 'board_item', 'pv2_item', remoteId, apply.board.remoteId)
      if (!link || link.deletedAt !== null) continue
      const removed = getBoardItem(link.localId)
      db.delete(boardItems).where(eq(boardItems.id, link.localId)).run()
      db.update(remoteLinks).set({ deletedAt: now, updatedAt: now }).where(eq(remoteLinks.id, link.id)).run()
      _logEvent(apply.projectId, 'board.item.removed', 'boards', 'system', null, 'item', link.localId, {
        boardItemId: link.localId,
        ...(removed ? { taskId: removed.taskId, columnId: removed.columnId } : {}),
        source: apply.source,
        remoteId,
      })
    }

    if (!isImport) {
      _logEvent(apply.projectId, 'board.mirror.synced', 'boards', 'system', null, 'board', localBoardId, {
        source: apply.source,
        remoteId: apply.board.remoteId,
        upserted: apply.upsertItems.length,
        deleted: apply.deleteRemoteIds.length,
      })
    }

    return localBoardId
  })

  return { boardId }
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
