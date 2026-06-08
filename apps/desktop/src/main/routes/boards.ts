import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listBoards, getBoard, createBoard, deleteBoard,
  listColumns, createColumn, updateColumn, deleteColumn,
  listSprints, getActiveSprint, createSprint, updateSprint, startSprint, completeSprint,
  listBoardItems, addBoardItem, moveBoardItem, removeBoardItem,
  listMilestones, createMilestone, updateMilestone, addMilestoneTask, listMilestoneTasks,
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
interface UpdateSprintBody  Partial<Pick<Sprint, 'name' | 'goal' | 'status' | 'startDate' | 'endDate' | 'velocity'>>
interface AddItemBody       { taskId: string; columnId: string; storyPoints?: number; sprintId?: string }
interface MoveItemBody      { columnId: string; sprintId?: string | null }
interface CreateMilestoneBody { title: string; description?: string; dueDate?: string }
interface UpdateMilestoneBody Partial<Pick<Milestone, 'title' | 'description' | 'dueDate' | 'status'>>
interface AddMilestoneTaskBody { taskId: string }
interface ListSprintsQuery  { status?: string }

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
      return createBoard(request.params.id, request.body)
    },
  )

  app.get<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const board = getBoard(request.params.boardId)
      if (!board) return reply.code(404).send({ error: 'Board not found' })
      return board
    },
  )

  app.delete<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      deleteBoard(request.params.boardId)
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
      return listColumns(request.params.boardId)
    },
  )

  app.patch<{ Params: ColumnParams; Body: UpdateColumnBody }>(
    '/projects/:id/boards/:boardId/columns/:columnId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ColumnParams; Body: UpdateColumnBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
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
      return createSprint(request.params.boardId, request.params.id, request.body)
    },
  )

  app.patch<{ Params: SprintParams; Body: UpdateSprintBody }>(
    '/projects/:id/boards/:boardId/sprints/:sprintId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SprintParams; Body: UpdateSprintBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
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
      const sprint = startSprint(request.params.sprintId)
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
      const sprint = completeSprint(request.params.sprintId)
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
      return listBoardItems(request.params.boardId)
    },
  )

  app.post<{ Params: BoardParams; Body: AddItemBody }>(
    '/projects/:id/boards/:boardId/items',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams; Body: AddItemBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const { taskId, columnId, storyPoints, sprintId } = request.body
      return addBoardItem(request.params.boardId, columnId, taskId, { storyPoints, sprintId })
    },
  )

  app.patch<{ Params: ItemParams; Body: MoveItemBody }>(
    '/projects/:id/boards/:boardId/items/:itemId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ItemParams; Body: MoveItemBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
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
      return createMilestone(request.params.id, request.body)
    },
  )

  app.patch<{ Params: MilestoneParams; Body: UpdateMilestoneBody }>(
    '/projects/:id/milestones/:milestoneId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: MilestoneParams; Body: UpdateMilestoneBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const m = updateMilestone(request.params.milestoneId, request.body)
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
      return listMilestoneTasks(request.params.milestoneId)
    },
  )

  app.post<{ Params: MilestoneParams; Body: AddMilestoneTaskBody }>(
    '/projects/:id/milestones/:milestoneId/tasks',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: MilestoneParams; Body: AddMilestoneTaskBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return addMilestoneTask(request.params.milestoneId, request.body.taskId)
    },
  )
}
