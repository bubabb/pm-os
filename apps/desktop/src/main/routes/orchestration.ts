import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listWorkspaces, getWorkspace, createWorkspace, updateWorkspaceStatus, terminateWorkspace,
  listTasks, getTask, createTask, updateTask,
  addEdge, getTaskEdges, getReadyTasks, listEdges,
  listApprovalGates, getApprovalGate, resolveApprovalGate,
} from '@creare/agent-orchestration'
import type { AgentWorkspace, Task } from '@creare/agent-orchestration'
import { listSprints, listMilestones } from '@creare/boards'

// Sub-resource guard — the gate must belong (via its task) to the project in the URL.
function gateInProject(gateId: string, projectId: string): boolean {
  const gate = getApprovalGate(gateId)
  if (!gate) return false
  const task = getTask(gate.taskId)
  return task !== null && task.projectId === projectId
}

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
  startDate?: string
  dueDate?: string
}

interface UpdateTaskBody {
  status?: Task['status']
  assigneeId?: string
  agentWorkspaceId?: string
  priority?: Task['priority']
  description?: string
  startDate?: string
  dueDate?: string
}

interface AddEdgeBody { fromTaskId: string; toTaskId: string }
interface UpdateWorkspaceStatusBody { status: AgentWorkspace['status'] }
interface ResolveGateBody { resolution: 'approved' | 'rejected'; reviewerNote?: string }
interface ListTasksQuery { status?: string }
interface ListGatesQuery { status?: string }

// Confirm a workspace/task actually belongs to the project in the URL (prevents
// cross-project access via a sub-resource id from another project).
function workspaceInProject(workspaceId: string, projectId: string): boolean {
  const w = getWorkspace(workspaceId)
  return w !== null && w.projectId === projectId
}
function taskInProject(taskId: string, projectId: string): boolean {
  const t = getTask(taskId)
  return t !== null && t.projectId === projectId
}

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
      return createWorkspace(request.params.id, request.body, user.id)
    },
  )

  app.get<{ Params: WorkspaceParams }>(
    '/projects/:id/workspaces/:workspaceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const ws = getWorkspace(request.params.workspaceId)
      if (!ws || ws.projectId !== request.params.id) return reply.code(404).send({ error: 'Workspace not found' })
      return ws
    },
  )

  app.patch<{ Params: WorkspaceParams; Body: UpdateWorkspaceStatusBody }>(
    '/projects/:id/workspaces/:workspaceId/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams; Body: UpdateWorkspaceStatusBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!workspaceInProject(request.params.workspaceId, request.params.id)) return reply.code(404).send({ error: 'Workspace not found' })
      updateWorkspaceStatus(request.params.workspaceId, request.body.status, user.id)
      return { ok: true }
    },
  )

  app.delete<{ Params: WorkspaceParams }>(
    '/projects/:id/workspaces/:workspaceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: WorkspaceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!workspaceInProject(request.params.workspaceId, request.params.id)) return reply.code(404).send({ error: 'Workspace not found' })
      terminateWorkspace(request.params.workspaceId, user.id)
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
      if (!task || task.projectId !== request.params.id) return reply.code(404).send({ error: 'Task not found' })
      return task
    },
  )

  app.patch<{ Params: TaskParams; Body: UpdateTaskBody }>(
    '/projects/:id/tasks/:taskId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TaskParams; Body: UpdateTaskBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!taskInProject(request.params.taskId, request.params.id)) return reply.code(404).send({ error: 'Task not found' })
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
      const result = addEdge(request.params.id, request.body.fromTaskId, request.body.toTaskId, user.id)
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
      if (!taskInProject(request.params.taskId, request.params.id)) return reply.code(404).send({ error: 'Task not found' })
      return getTaskEdges(request.params.taskId)
    },
  )

  // ── Timeline (Gantt) ───────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/timeline',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const projectId = request.params.id
      return {
        tasks: listTasks(projectId),
        edges: listEdges(projectId),
        sprints: listSprints(projectId),
        milestones: listMilestones(projectId),
      }
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
      if (!gateInProject(request.params.gateId, request.params.id)) return reply.code(404).send({ error: 'Gate not found' })
      const gate = resolveApprovalGate(request.params.gateId, request.body.resolution, request.body.reviewerNote)
      if (!gate) return reply.code(404).send({ error: 'Gate not found or already resolved' })
      return gate
    },
  )
}
