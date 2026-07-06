import { getDb, agentWorkspaces, tasks, taskEdges, approvalGates, events } from '@pm-os/database'
import { eq, and, inArray, ne } from 'drizzle-orm'
import { generateId } from '@pm-os/shared'
import type { InferSelectModel } from 'drizzle-orm'

// ── Re-exported types ─────────────────────────────────────────────────────────

export type AgentWorkspace = InferSelectModel<typeof agentWorkspaces>
export type Task           = InferSelectModel<typeof tasks>
export type TaskEdge       = InferSelectModel<typeof taskEdges>
export type ApprovalGate   = InferSelectModel<typeof approvalGates>

// ── Agent tool executor ─────────────────────────────────────────────────────

export type { ToolContext, AgentToolSchema, ToolResult } from './tools'
export { listAgentTools, executeAgentTool } from './tools'
// Execution runtime — actually runs an agent task (the CONTRACT's startTask/cancelTask).
export { startTask, cancelTask, recoverStaleAgentTasks } from './executor'
export type { ExecuteTaskOptions } from './executor'

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

export function createWorkspace(projectId: string, params: CreateWorkspaceParams, actorId?: string): AgentWorkspace {
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

  _logEvent(projectId, 'agent.workspace.created', 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'agent_workspace', id, { name: params.name, modelId: params.modelId })

  return getWorkspace(id)!
}

export function updateWorkspaceStatus(id: string, status: AgentWorkspace['status'], actorId?: string): void {
  const ws = getWorkspace(id)
  if (!ws) return
  const now = new Date().toISOString()
  getDb().update(agentWorkspaces)
    .set({ status, lastActiveAt: now, updatedAt: now })
    .where(eq(agentWorkspaces.id, id))
    .run()

  // Every workspace state change is an event (terminated gets its own dedicated type).
  const type = status === 'terminated' ? 'agent.workspace.terminated' : 'agent.workspace.status_changed'
  _logEvent(ws.projectId, type, 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'agent_workspace', id, {
    status, previousStatus: ws.status,
  })
}

export function terminateWorkspace(id: string, actorId?: string): void {
  // Delegates to updateWorkspaceStatus, which emits the agent.workspace.terminated event.
  updateWorkspaceStatus(id, 'terminated', actorId)
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
  startDate?: string
  dueDate?: string
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
    startDate: params.startDate ?? null,
    dueDate: params.dueDate ?? null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  _logEvent(projectId, 'task.created', 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'task', id, {
    taskId: id, projectId, type: params.type, title: params.title, priority: params.priority ?? 'medium',
  })

  return getTask(id)!
}

export function updateTask(
  id: string,
  update: Partial<Pick<Task, 'status' | 'assigneeId' | 'agentWorkspaceId' | 'priority' | 'description' | 'startDate' | 'dueDate' | 'result'>>,
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
  if (update.startDate !== undefined)        patch['startDate'] = update.startDate
  if (update.dueDate !== undefined)          patch['dueDate'] = update.dueDate
  if (update.result !== undefined)           patch['result'] = update.result

  getDb().update(tasks).set(patch).where(eq(tasks.id, id)).run()

  // Emit an event for every change — status transitions get a typed event, other field
  // edits get a generic task.updated so no mutation is silent.
  if (update.status) {
    _logEvent(task.projectId, `task.${update.status}`, 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'task', id, { taskId: id, previousStatus: task.status })
  } else {
    const changed = Object.keys(patch).filter((k) => k !== 'updatedAt')
    if (changed.length > 0) {
      _logEvent(task.projectId, 'task.updated', 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'task', id, { taskId: id, changed })
    }
  }

  return getTask(id)
}

// ── DAG edge management ───────────────────────────────────────────────────────

export interface AddEdgeResult {
  ok: boolean
  error?: 'cycle_detected' | 'self_loop' | 'duplicate' | 'not_found'
  edge?: TaskEdge
}

// Sentinel used to bubble a detected cycle out of the addEdge transaction.
class _CycleError extends Error {}

export function addEdge(projectId: string, fromTaskId: string, toTaskId: string, actorId?: string): AddEdgeResult {
  if (fromTaskId === toTaskId) return { ok: false, error: 'self_loop' }

  // Both endpoints must belong to this project — prevents inserting cross-project edges.
  const from = getTask(fromTaskId)
  const to = getTask(toTaskId)
  if (!from || from.projectId !== projectId || !to || to.projectId !== projectId) {
    return { ok: false, error: 'not_found' }
  }

  const id = generateId()
  const now = new Date().toISOString()
  const db = getDb()
  try {
    // Cycle check + insert are atomic so two concurrent addEdge calls can't both pass
    // the reachability test and create a cycle.
    db.transaction((tx) => {
      if (_canReach(toTaskId, fromTaskId)) throw new _CycleError()
      tx.insert(taskEdges).values({ id, projectId, fromTaskId, toTaskId, createdAt: now }).run()
    })
  } catch (err) {
    if (err instanceof _CycleError) return { ok: false, error: 'cycle_detected' }
    return { ok: false, error: 'duplicate' }
  }

  const edge = db.select().from(taskEdges).where(eq(taskEdges.id, id)).limit(1).all()[0]!
  _logEvent(projectId, 'task.edge.added', 'agent-orchestration', actorId ? 'user' : 'system', actorId ?? null, 'task_edge', id, { fromTaskId, toTaskId })
  return { ok: true, edge }
}

// All dependency edges for a project — the Gantt view needs every edge to draw arrows.
export function listEdges(projectId: string): TaskEdge[] {
  return getDb().select().from(taskEdges).where(eq(taskEdges.projectId, projectId)).all()
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
// Three queries total (pending tasks, all project edges, all project task
// statuses) with readiness computed in memory — no per-task edge lookups.
export function getReadyTasks(projectId: string): Task[] {
  const pending = listTasks(projectId, { status: 'pending' })
  if (pending.length === 0) return []

  const edges = listEdges(projectId)
  if (edges.length === 0) return pending

  const statusById = new Map(listTasks(projectId).map((t) => [t.id, t.status]))

  const incomingByTask = new Map<string, string[]>()
  for (const e of edges) {
    const deps = incomingByTask.get(e.toTaskId)
    if (deps) deps.push(e.fromTaskId)
    else incomingByTask.set(e.toTaskId, [e.fromTaskId])
  }

  return pending.filter((task) => {
    const deps = incomingByTask.get(task.id)
    if (!deps) return true
    return deps.every((fromId) => statusById.get(fromId) === 'completed')
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
  if (!task) throw new Error(`Cannot create approval gate: task not found: ${taskId}`)

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

  updateTask(taskId, { status: 'waiting_approval' })
  _logEvent(task.projectId, 'approval.gate.created', 'agent-orchestration', 'agent', requestedBy, 'approval_gate', id, { taskId, reviewerId })

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

export function getApprovalGate(id: string): ApprovalGate | null {
  const [g] = getDb().select().from(approvalGates).where(eq(approvalGates.id, id)).limit(1).all()
  return g ?? null
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
    // CONTRACT: single approval.gate.resolved event carrying the resolution status.
    _logEvent(task.projectId, 'approval.gate.resolved', 'agent-orchestration', 'user', gate.reviewerId, 'approval_gate', gateId, {
      gateId, status: resolution, reviewerId: gate.reviewerId, taskId: gate.taskId,
    })
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
