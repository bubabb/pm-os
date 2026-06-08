import { getDb, agentWorkspaces, tasks, taskEdges, approvalGates, events } from '@creare/database'
import { eq, and, inArray, ne } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import type { InferSelectModel } from 'drizzle-orm'

// ── Re-exported types ─────────────────────────────────────────────────────────

export type AgentWorkspace = InferSelectModel<typeof agentWorkspaces>
export type Task           = InferSelectModel<typeof tasks>
export type TaskEdge       = InferSelectModel<typeof taskEdges>
export type ApprovalGate   = InferSelectModel<typeof approvalGates>

// ── Workspace management ──────────────────────────────────────────────────────

export interface CreateWorkspaceParams {
  name: string
  modelProvider: AgentWorkspace['modelProvider']
  modelId: string
  permissionScope?: Record<string, unknown>
  dailyTokenLimit?: number
  dailyCostLimitCents?: number
}

export function listWorkspaces(projectId: string): AgentWorkspace[] {
  return getDb()
    .select()
    .from(agentWorkspaces)
    .where(and(
      eq(agentWorkspaces.projectId, projectId),
      ne(agentWorkspaces.status, 'terminated'),
    ))
    .all()
}

export function getWorkspace(id: string): AgentWorkspace | null {
  const [ws] = getDb()
    .select()
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.id, id))
    .limit(1)
    .all()
  return ws ?? null
}

export function createWorkspace(projectId: string, params: CreateWorkspaceParams): AgentWorkspace {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(agentWorkspaces).values({
    id,
    projectId,
    name: params.name,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    status: 'idle',
    permissionScope: JSON.stringify(params.permissionScope ?? {}),
    dailyTokenLimit: params.dailyTokenLimit ?? null,
    dailyCostLimitCents: params.dailyCostLimitCents ?? null,
    tokensUsedToday: 0,
    costUsedTodayCents: 0,
    tokensResetDate: now.split('T')[0] ?? null,
    lastActiveAt: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  _logEvent(projectId, 'agent.workspace.created', 'agent-orchestration', 'user', id, 'agent_workspace', id, { name: params.name, modelId: params.modelId })

  return getWorkspace(id)!
}

export function updateWorkspaceStatus(id: string, status: AgentWorkspace['status']): void {
  const now = new Date().toISOString()
  getDb().update(agentWorkspaces)
    .set({ status, lastActiveAt: now, updatedAt: now })
    .where(eq(agentWorkspaces.id, id))
    .run()
}

export function terminateWorkspace(id: string): void {
  const ws = getWorkspace(id)
  if (!ws) return
  updateWorkspaceStatus(id, 'terminated')
  _logEvent(ws.projectId, 'agent.workspace.terminated', 'agent-orchestration', 'user', null, 'agent_workspace', id, {})
}

// ── Task management ───────────────────────────────────────────────────────────

export interface CreateTaskParams {
  title: string
  description?: string
  type: Task['type']
  priority?: Task['priority']
  assigneeId?: string
  agentWorkspaceId?: string
  estimatedMinutes?: number
}

export function listTasks(
  projectId: string,
  opts?: { status?: Task['status'] | Task['status'][] },
): Task[] {
  const db = getDb()
  if (!opts?.status) {
    return db.select().from(tasks).where(eq(tasks.projectId, projectId)).all()
  }
  const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
  return db.select().from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, statuses)))
    .all()
}

export function getTask(id: string): Task | null {
  const [t] = getDb().select().from(tasks).where(eq(tasks.id, id)).limit(1).all()
  return t ?? null
}

export function createTask(projectId: string, params: CreateTaskParams, actorId?: string): Task {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(tasks).values({
    id,
    projectId,
    title: params.title,
    description: params.description ?? null,
    type: params.type,
    status: 'pending',
    priority: params.priority ?? 'medium',
    assigneeId: params.assigneeId ?? null,
    agentWorkspaceId: params.agentWorkspaceId ?? null,
    estimatedMinutes: params.estimatedMinutes ?? null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  _logEvent(projectId, 'task.created', 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'task', id, {
    title: params.title, type: params.type, priority: params.priority ?? 'medium',
  })

  return getTask(id)!
}

export function updateTask(
  id: string,
  update: Partial<Pick<Task, 'status' | 'assigneeId' | 'agentWorkspaceId' | 'priority' | 'description'>>,
  actorId?: string,
): Task | null {
  const task = getTask(id)
  if (!task) return null

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { updatedAt: now }

  if (update.status !== undefined) {
    patch['status'] = update.status
    if (update.status === 'in_progress') patch['startedAt'] = now
    if (
      update.status === 'completed' ||
      update.status === 'failed' ||
      update.status === 'cancelled'
    ) {
      patch['completedAt'] = now
    }
  }
  if (update.assigneeId !== undefined)       patch['assigneeId'] = update.assigneeId
  if (update.agentWorkspaceId !== undefined) patch['agentWorkspaceId'] = update.agentWorkspaceId
  if (update.priority !== undefined)         patch['priority'] = update.priority
  if (update.description !== undefined)      patch['description'] = update.description

  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run()

  if (update.status) {
    _logEvent(task.projectId, `task.${update.status}`, 'agent-orchestration', 'user', actorId ?? null, 'task', id, { previousStatus: task.status })
  }

  return getTask(id)
}

// ── DAG edge management ───────────────────────────────────────────────────────

export interface AddEdgeResult {
  ok: boolean
  error?: 'cycle_detected' | 'self_loop' | 'duplicate'
  edge?: TaskEdge
}

export function addEdge(projectId: string, fromTaskId: string, toTaskId: string): AddEdgeResult {
  if (fromTaskId === toTaskId) return { ok: false, error: 'self_loop' }

  // Detect cycle: if toTaskId can already reach fromTaskId, adding this edge creates a cycle.
  if (_canReach(toTaskId, fromTaskId)) {
    return { ok: false, error: 'cycle_detected' }
  }

  const id = generateId()
  const now = new Date().toISOString()
  try {
    getDb().insert(taskEdges).values({ id, projectId, fromTaskId, toTaskId, createdAt: now }).run()
  } catch {
    return { ok: false, error: 'duplicate' }
  }

  const edge = getDb().select().from(taskEdges).where(eq(taskEdges.id, id)).limit(1).all()[0]!
  _logEvent(projectId, 'task.edge.added', 'agent-orchestration', 'user', null, 'task_edge', id, { fromTaskId, toTaskId })
  return { ok: true, edge }
}

export function getTaskEdges(taskId: string): { dependencies: Task[]; dependents: Task[] } {
  const db = getDb()
  const incoming = db.select().from(taskEdges).where(eq(taskEdges.toTaskId, taskId)).all()
  const outgoing = db.select().from(taskEdges).where(eq(taskEdges.fromTaskId, taskId)).all()

  const depIds = incoming.map((e) => e.fromTaskId)
  const dntIds = outgoing.map((e) => e.toTaskId)

  const dependencies = depIds.length > 0
    ? db.select().from(tasks).where(inArray(tasks.id, depIds)).all()
    : []
  const dependents = dntIds.length > 0
    ? db.select().from(tasks).where(inArray(tasks.id, dntIds)).all()
    : []

  return { dependencies, dependents }
}

// Returns pending tasks whose all upstream dependencies are completed.
export function getReadyTasks(projectId: string): Task[] {
  const pending = listTasks(projectId, { status: 'pending' })
  return pending.filter((task) => {
    const { dependencies } = getTaskEdges(task.id)
    return dependencies.every((dep) => dep.status === 'completed')
  })
}

// ── Approval gate management ──────────────────────────────────────────────────

export function createApprovalGate(
  taskId: string,
  requestedBy: string,
  reviewerId: string,
  context: Record<string, unknown>,
): ApprovalGate {
  const task = getTask(taskId)
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(approvalGates).values({
    id,
    taskId,
    requestedBy,
    reviewerId,
    status: 'pending',
    context: JSON.stringify(context),
    reviewerNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  if (task) {
    updateTask(taskId, { status: 'waiting_approval' })
    _logEvent(task.projectId, 'approval.gate.created', 'agent-orchestration', 'agent', requestedBy, 'approval_gate', id, { taskId, reviewerId })
  }

  return getDb().select().from(approvalGates).where(eq(approvalGates.id, id)).limit(1).all()[0]!
}

export function listApprovalGates(projectId: string, status?: ApprovalGate['status']): ApprovalGate[] {
  const db = getDb()
  const projectTasks = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)).all()
  const taskIds = projectTasks.map((t) => t.id)
  if (taskIds.length === 0) return []

  const where = status
    ? and(inArray(approvalGates.taskId, taskIds), eq(approvalGates.status, status))
    : inArray(approvalGates.taskId, taskIds)

  return db.select().from(approvalGates).where(where).all()
}

export function resolveApprovalGate(
  gateId: string,
  resolution: 'approved' | 'rejected',
  reviewerNote?: string,
): ApprovalGate | null {
  const db = getDb()
  const [gate] = db.select().from(approvalGates).where(eq(approvalGates.id, gateId)).limit(1).all()
  if (!gate || gate.status !== 'pending') return null

  const now = new Date().toISOString()
  db.update(approvalGates)
    .set({ status: resolution, reviewerNote: reviewerNote ?? null, resolvedAt: now, updatedAt: now })
    .where(eq(approvalGates.id, gateId))
    .run()

  const task = getTask(gate.taskId)
  if (task) {
    const newStatus: Task['status'] = resolution === 'approved' ? 'in_progress' : 'cancelled'
    updateTask(gate.taskId, { status: newStatus })
    _logEvent(task.projectId, `approval.gate.${resolution}`, 'agent-orchestration', 'user', gate.reviewerId, 'approval_gate', gateId, { taskId: gate.taskId })
  }

  return db.select().from(approvalGates).where(eq(approvalGates.id, gateId)).limit(1).all()[0] ?? null
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// DFS check: can startId reach targetId through existing directed edges?
function _canReach(startId: string, targetId: string, visited = new Set<string>()): boolean {
  if (startId === targetId) return true
  if (visited.has(startId)) return false
  visited.add(startId)

  const outgoing = getDb().select().from(taskEdges).where(eq(taskEdges.fromTaskId, startId)).all()
  return outgoing.some((e) => _canReach(e.toTaskId, targetId, visited))
}

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
