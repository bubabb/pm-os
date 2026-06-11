import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listBoards, getBoard, createBoard, deleteBoard,
  listColumns, getColumn, updateColumn, deleteColumn,
  listSprints, getActiveSprint, getSprint, createSprint, updateSprint, startSprint, completeSprint,
  listBoardItems, getBoardItem, addBoardItem, moveBoardItem, removeBoardItem,
  listMilestones, getMilestone, createMilestone, updateMilestone, addMilestoneTask, listMilestoneTasks,
} from '@creare/boards'
import type { Board, Sprint, Milestone } from '@creare/boards'

interface ProjectParams   { id: string }
interface BoardParams     { id: string; boardId: string }
interface ColumnParams    { id: string; boardId: string; columnId: string }
interface SprintParams    { id: string; boardId: string; sprintId: string }
interface ItemParams      { id: string; boardId: string; itemId: string }
interface MilestoneParams { id: string; milestoneId: string }

interface CreateBoardBody   { name: string; type?: Board['type'] }
interface UpdateColumnBody  { name?: string; position?: number; isTerminal?: boolean; wipLimit?: number }
interface CreateSprintBody  { name: string; goal?: string; startDate?: string; endDate?: string }
type UpdateSprintBody = Partial<Pick<Sprint, 'name' | 'goal' | 'startDate' | 'endDate' | 'velocity'>>
interface AddItemBody       { taskId: string; columnId: string; storyPoints?: number; sprintId?: string }
interface MoveItemBody      { columnId: string; sprintId?: string | null }
interface CreateMilestoneBody { title: string; description?: string; dueDate?: string }
type UpdateMilestoneBody = Partial<Pick<Milestone, 'title' | 'description' | 'dueDate' | 'status'>>
interface AddMilestoneTaskBody { taskId: string }
interface ListSprintsQuery  { status?: string }

// Sub-resource ownership guards — confirm the board/sprint/milestone actually belongs to
// the project in the URL, so access to project A can't reach entities in project B.
function boardInProject(boardId: string, projectId: string): boolean {
  const b = getBoard(boardId)
  return b !== null && b.projectId === projectId
}
function sprintInProject(sprintId: string, projectId: string): boolean {
  const s = getSprint(sprintId)
  return s !== null && s.projectId === projectId
}
function milestoneInProject(milestoneId: string, projectId: string): boolean {
  const m = getMilestone(milestoneId)
  return m !== null && m.projectId === projectId
}
// Leaf-resource guards — a column/item id must belong to the board in the URL, so a
// user with access to one board can't reach columns/items on another board.
function columnInBoard(columnId: string, boardId: string): boolean {
  const c = getColumn(columnId)
  return c !== null && c.boardId === boardId
}
function itemInBoard(itemId: string, boardId: string): boolean {
  const i = getBoardItem(itemId)
  return i !== null && i.boardId === boardId
}

export async function boardsRoutes(app: FastifyInstance): Promise<void> {
  // ── Boards ─────────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/boards',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return listBoards(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateBoardBody }>(
    '/projects/:id/boards',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateBoardBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return createBoard(request.params.id, request.body, user.id)
    },
  )

  app.get<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const board = getBoard(request.params.boardId)
      if (!board || board.projectId !== request.params.id) return reply.code(404).send({ error: 'Board not found' })
      return board
    },
  )

  app.delete<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      deleteBoard(request.params.boardId, user.id)
      return { ok: true }
    },
  )

  // ── Columns ────────────────────────────────────────────────────────────────

  app.get<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId/columns',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      return listColumns(request.params.boardId)
    },
  )

  app.patch<{ Params: ColumnParams; Body: UpdateColumnBody }>(
    '/projects/:id/boards/:boardId/columns/:columnId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ColumnParams; Body: UpdateColumnBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!columnInBoard(request.params.columnId, request.params.boardId)) return reply.code(404).send({ error: 'Column not found' })
      const col = updateColumn(request.params.columnId, request.body)
      if (!col) return reply.code(404).send({ error: 'Column not found' })
      return col
    },
  )

  app.delete<{ Params: ColumnParams }>(
    '/projects/:id/boards/:boardId/columns/:columnId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ColumnParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!columnInBoard(request.params.columnId, request.params.boardId)) return reply.code(404).send({ error: 'Column not found' })
      deleteColumn(request.params.columnId)
      return { ok: true }
    },
  )

  // ── Sprints ────────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListSprintsQuery }>(
    '/projects/:id/sprints',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListSprintsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const status = request.query.status as Sprint['status'] | undefined
      return listSprints(request.params.id, status ? { status } : undefined)
    },
  )

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/sprints/active',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const sprint = getActiveSprint(request.params.id)
      if (!sprint) return reply.code(404).send({ error: 'No active sprint' })
      return sprint
    },
  )

  app.post<{ Params: BoardParams; Body: CreateSprintBody }>(
    '/projects/:id/boards/:boardId/sprints',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams; Body: CreateSprintBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      return createSprint(request.params.boardId, request.params.id, request.body, user.id)
    },
  )

  app.patch<{ Params: SprintParams; Body: UpdateSprintBody }>(
    '/projects/:id/boards/:boardId/sprints/:sprintId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SprintParams; Body: UpdateSprintBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!sprintInProject(request.params.sprintId, request.params.id)) return reply.code(404).send({ error: 'Sprint not found' })
      const sprint = updateSprint(request.params.sprintId, request.body)
      if (!sprint) return reply.code(404).send({ error: 'Sprint not found' })
      return sprint
    },
  )

  app.post<{ Params: SprintParams }>(
    '/projects/:id/boards/:boardId/sprints/:sprintId/start',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SprintParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!sprintInProject(request.params.sprintId, request.params.id)) return reply.code(404).send({ error: 'Sprint not found' })
      const sprint = startSprint(request.params.sprintId, user.id)
      if (!sprint) return reply.code(422).send({ error: 'Cannot start sprint: sprint not in planning, or an active sprint already exists' })
      return sprint
    },
  )

  app.post<{ Params: SprintParams }>(
    '/projects/:id/boards/:boardId/sprints/:sprintId/complete',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SprintParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!sprintInProject(request.params.sprintId, request.params.id)) return reply.code(404).send({ error: 'Sprint not found' })
      const sprint = completeSprint(request.params.sprintId, user.id)
      if (!sprint) return reply.code(422).send({ error: 'Cannot complete sprint: sprint not active' })
      return sprint
    },
  )

  // ── Board items ────────────────────────────────────────────────────────────

  app.get<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId/items',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      return listBoardItems(request.params.boardId)
    },
  )

  app.post<{ Params: BoardParams; Body: AddItemBody }>(
    '/projects/:id/boards/:boardId/items',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams; Body: AddItemBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      const { taskId, columnId, storyPoints, sprintId } = request.body
      if (!columnInBoard(columnId, request.params.boardId)) return reply.code(422).send({ error: 'Column does not belong to this board' })
      return addBoardItem(request.params.boardId, columnId, taskId, {
        ...(storyPoints !== undefined ? { storyPoints } : {}),
        ...(sprintId !== undefined ? { sprintId } : {}),
      })
    },
  )

  app.patch<{ Params: ItemParams; Body: MoveItemBody }>(
    '/projects/:id/boards/:boardId/items/:itemId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ItemParams; Body: MoveItemBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!itemInBoard(request.params.itemId, request.params.boardId)) return reply.code(404).send({ error: 'Item not found' })
      if (!columnInBoard(request.body.columnId, request.params.boardId)) return reply.code(422).send({ error: 'Column does not belong to this board' })
      const item = moveBoardItem(request.params.itemId, request.body.columnId, request.body.sprintId)
      if (!item) return reply.code(404).send({ error: 'Item not found' })
      return item
    },
  )

  app.delete<{ Params: ItemParams }>(
    '/projects/:id/boards/:boardId/items/:itemId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ItemParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!boardInProject(request.params.boardId, request.params.id)) return reply.code(404).send({ error: 'Board not found' })
      if (!itemInBoard(request.params.itemId, request.params.boardId)) return reply.code(404).send({ error: 'Item not found' })
      removeBoardItem(request.params.itemId)
      return { ok: true }
    },
  )

  // ── Milestones ─────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/milestones',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return listMilestones(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateMilestoneBody }>(
    '/projects/:id/milestones',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateMilestoneBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return createMilestone(request.params.id, request.body, user.id)
    },
  )

  app.patch<{ Params: MilestoneParams; Body: UpdateMilestoneBody }>(
    '/projects/:id/milestones/:milestoneId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: MilestoneParams; Body: UpdateMilestoneBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!milestoneInProject(request.params.milestoneId, request.params.id)) return reply.code(404).send({ error: 'Milestone not found' })
      const m = updateMilestone(request.params.milestoneId, request.body, user.id)
      if (!m) return reply.code(404).send({ error: 'Milestone not found' })
      return m
    },
  )

  app.get<{ Params: MilestoneParams }>(
    '/projects/:id/milestones/:milestoneId/tasks',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: MilestoneParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!milestoneInProject(request.params.milestoneId, request.params.id)) return reply.code(404).send({ error: 'Milestone not found' })
      return listMilestoneTasks(request.params.milestoneId)
    },
  )

  app.post<{ Params: MilestoneParams; Body: AddMilestoneTaskBody }>(
    '/projects/:id/milestones/:milestoneId/tasks',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: MilestoneParams; Body: AddMilestoneTaskBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!milestoneInProject(request.params.milestoneId, request.params.id)) return reply.code(404).send({ error: 'Milestone not found' })
      return addMilestoneTask(request.params.milestoneId, request.body.taskId)
    },
  )
}
