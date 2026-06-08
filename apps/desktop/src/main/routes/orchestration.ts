import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listWorkspaces, getWorkspace, createWorkspace, updateWorkspaceStatus, terminateWorkspace,
  listTasks, getTask, createTask, updateTask,
  addEdge, getTaskEdges, getReadyTasks,
  listApprovalGates, resolveApprovalGate,
} from '@creare/agent-orchestration'
import type { AgentWorkspace, Task } from '@creare/agent-orchestration'

interface ProjectParams  { id: string }
interface WorkspaceParams { id: string; workspaceId: string }
interface TaskParams      { id: string; taskId: string }
interface GateParams      { id: string; gateId: string }

interface CreateWorkspaceBody {
  name: string
  modelProvider: AgentWorkspace['modelProvider']
  modelId: string
  permissionScope?: Record<string, unknown>
  dailyTokenLimit?: number
  dailyCostLimitCents?: number
}

interface CreateTaskBody {
  title: string
  description?: string
  type: Task['type']
  priority?: Task['priority']
  assigneeId?: string
  agentWorkspaceId?: string
  estimatedMinutes?: number
}

interface UpdateTaskBody {
  status?: Task['status']
  assigneeId?: string
  agentWorkspaceId?: string
  priority?: Task['priority']
  description?: string
}

interface AddEdgeBody { fromTaskId: string; toTaskId: string }
interface UpdateWorkspaceStatusBody { status: AgentWorkspace['status'] }
interface ResolveGateBody { resolution: 'approved' | 'rejected'; reviewerNote?: string }
interface ListTasksQuery { status?: string }
interface ListGatesQuery { status?: string }

export async function orchestrationRoutes(app: FastifyInstance): Promise<void> {
  // ── Workspaces ─────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/workspaces',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return listWorkspaces(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateWorkspaceBody }>(
    '/projects/:id/workspaces',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateWorkspaceBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return createWorkspace(request.params.id, request.body)
    },
  )

  app.get<{ Params: WorkspaceParams }>(
    '/projects/:id/workspaces/:workspaceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const ws = getWorkspace(request.params.workspaceId)
      if (!ws) return reply.code(404).send({ error: 'Workspace not found' })
      return ws
    },
  )

  app.patch<{ Params: WorkspaceParams; Body: UpdateWorkspaceStatusBody }>(
    '/projects/:id/workspaces/:workspaceId/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams; Body: UpdateWorkspaceStatusBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      updateWorkspaceStatus(request.params.workspaceId, request.body.status)
      return { ok: true }
    },
  )

  app.delete<{ Params: WorkspaceParams }>(
    '/projects/:id/workspaces/:workspaceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      terminateWorkspace(request.params.workspaceId)
      return { ok: true }
    },
  )

  // ── Tasks ──────────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListTasksQuery }>(
    '/projects/:id/tasks',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListTasksQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const status = request.query.status as Task['status'] | undefined
      return listTasks(request.params.id, status ? { status } : undefined)
    },
  )

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/tasks/ready',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return getReadyTasks(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateTaskBody }>(
    '/projects/:id/tasks',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateTaskBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return createTask(request.params.id, request.body, user.id)
    },
  )

  app.get<{ Params: TaskParams }>(
    '/projects/:id/tasks/:taskId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TaskParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const task = getTask(request.params.taskId)
      if (!task) return reply.code(404).send({ error: 'Task not found' })
      return task
    },
  )

  app.patch<{ Params: TaskParams; Body: UpdateTaskBody }>(
    '/projects/:id/tasks/:taskId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TaskParams; Body: UpdateTaskBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const updated = updateTask(request.params.taskId, request.body, user.id)
      if (!updated) return reply.code(404).send({ error: 'Task not found' })
      return updated
    },
  )

  // ── DAG edges ──────────────────────────────────────────────────────────────

  app.post<{ Params: ProjectParams; Body: AddEdgeBody }>(
    '/projects/:id/tasks/edges',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: AddEdgeBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const result = addEdge(request.params.id, request.body.fromTaskId, request.body.toTaskId)
      if (!result.ok) return reply.code(422).send({ error: result.error })
      return result.edge
    },
  )

  app.get<{ Params: TaskParams }>(
    '/projects/:id/tasks/:taskId/edges',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TaskParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return getTaskEdges(request.params.taskId)
    },
  )

  // ── Approval gates ─────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListGatesQuery }>(
    '/projects/:id/approval-gates',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListGatesQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const status = request.query.status as 'pending' | 'approved' | 'rejected' | undefined
      return listApprovalGates(request.params.id, status)
    },
  )

  app.post<{ Params: GateParams; Body: ResolveGateBody }>(
    '/projects/:id/approval-gates/:gateId/resolve',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: GateParams; Body: ResolveGateBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const gate = resolveApprovalGate(request.params.gateId, request.body.resolution, request.body.reviewerNote)
      if (!gate) return reply.code(404).send({ error: 'Gate not found or already resolved' })
      return gate
    },
  )
}
