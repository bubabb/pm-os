import {
  getDb, events, traces, traceEvents, auditLog, agentWorkspaces,
} from '@pm-os/database'
import { eq, and, desc, asc, max, getTableColumns } from 'drizzle-orm'
import { generateId } from '@pm-os/shared'
import type { InferSelectModel } from 'drizzle-orm'

// ── Re-exported types ─────────────────────────────────────────────────────────

export type Event      = InferSelectModel<typeof events>
export type Trace      = InferSelectModel<typeof traces>
export type TraceEvent = InferSelectModel<typeof traceEvents>
export type AuditEntry = InferSelectModel<typeof auditLog>

export type TraceWithWorkspace = Trace & { workspaceName: string | null }

// ── Traces ────────────────────────────────────────────────────────────────────

export interface CreateTraceParams {
  agentWorkspaceId: string
  projectId: string
  taskId?: string
}

export interface UpdateTraceParams {
  status?: Trace['status']
  inputTokens?: number
  outputTokens?: number
  costCents?: number
  durationMs?: number
  completedAt?: string
}

export function listTraces(
  projectId: string,
  opts?: { status?: Trace['status'] },
): TraceWithWorkspace[] {
  const db = getDb()
  const where = opts?.status
    ? and(eq(traces.projectId, projectId), eq(traces.status, opts.status))
    : eq(traces.projectId, projectId)

  // Single LEFT JOIN instead of one workspace lookup per trace (this endpoint is polled).
  return db
    .select({ ...getTableColumns(traces), workspaceName: agentWorkspaces.name })
    .from(traces)
    .leftJoin(agentWorkspaces, eq(agentWorkspaces.id, traces.agentWorkspaceId))
    .where(where)
    .orderBy(desc(traces.startedAt))
    .all()
}

export function getTrace(traceId: string): TraceWithWorkspace | null {
  const db = getDb()
  const [t] = db.select().from(traces).where(eq(traces.id, traceId)).limit(1).all()
  if (!t) return null
  const [ws] = db.select({ name: agentWorkspaces.name })
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.id, t.agentWorkspaceId))
    .limit(1)
    .all()
  return { ...t, workspaceName: ws?.name ?? null }
}

export function createTrace(params: CreateTraceParams): Trace {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(traces).values({
    id,
    agentWorkspaceId: params.agentWorkspaceId,
    projectId: params.projectId,
    taskId: params.taskId ?? null,
    status: 'running',
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    durationMs: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
  }).run()
  return getDb().select().from(traces).where(eq(traces.id, id)).limit(1).all()[0]!
}

export function updateTrace(traceId: string, update: UpdateTraceParams): Trace | null {
  const patch: Record<string, unknown> = {}
  if (update.status !== undefined)       patch['status'] = update.status
  if (update.inputTokens !== undefined)  patch['inputTokens'] = update.inputTokens
  if (update.outputTokens !== undefined) patch['outputTokens'] = update.outputTokens
  if (update.costCents !== undefined)    patch['costCents'] = update.costCents
  if (update.durationMs !== undefined)   patch['durationMs'] = update.durationMs
  if (update.completedAt !== undefined)  patch['completedAt'] = update.completedAt

  getDb().update(traces).set(patch).where(eq(traces.id, traceId)).run()
  const [t] = getDb().select().from(traces).where(eq(traces.id, traceId)).limit(1).all()
  return t ?? null
}

// ── Trace events ──────────────────────────────────────────────────────────────

export interface AddTraceEventParams {
  type: TraceEvent['type']
  payload?: Record<string, unknown>
  durationMs?: number
}

export function listTraceEvents(traceId: string): TraceEvent[] {
  return getDb()
    .select()
    .from(traceEvents)
    .where(eq(traceEvents.traceId, traceId))
    .orderBy(asc(traceEvents.sequenceNumber))
    .all()
}

export function addTraceEvent(traceId: string, params: AddTraceEventParams): TraceEvent {
  const id = generateId()
  const now = new Date().toISOString()
  const db = getDb()

  // Compute next sequence number and insert atomically so concurrent events on the same
  // trace (e.g. parallel tool calls) cannot be assigned duplicate sequence numbers.
  db.transaction((tx) => {
    const [maxRow] = tx
      .select({ max: max(traceEvents.sequenceNumber) })
      .from(traceEvents)
      .where(eq(traceEvents.traceId, traceId))
      .all()
    const nextSeq = (maxRow?.max ?? -1) + 1
    tx.insert(traceEvents).values({
      id,
      traceId,
      type: params.type,
      sequenceNumber: nextSeq,
      payload: JSON.stringify(params.payload ?? {}),
      durationMs: params.durationMs ?? null,
      createdAt: now,
    }).run()
  })
  return db.select().from(traceEvents).where(eq(traceEvents.id, id)).limit(1).all()[0]!
}

// ── Event log (read-only views) ───────────────────────────────────────────────

export interface ListEventsOpts {
  domain?: string
  type?: string
  resourceType?: string
  resourceId?: string
  limit?: number
}

export function listEventLog(projectId: string, opts: ListEventsOpts = {}): Event[] {
  const db = getDb()
  let query = db.select().from(events).$dynamic()

  const conditions = [eq(events.projectId, projectId)]
  if (opts.domain)       conditions.push(eq(events.domain, opts.domain))
  if (opts.type)         conditions.push(eq(events.type, opts.type))
  if (opts.resourceType) conditions.push(eq(events.resourceType, opts.resourceType))
  if (opts.resourceId)   conditions.push(eq(events.resourceId, opts.resourceId))

  query = query.where(and(...conditions)).orderBy(desc(events.createdAt))
  if (opts.limit) query = query.limit(opts.limit)

  return query.all()
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AddAuditEntryParams {
  projectId?: string
  actorType: AuditEntry['actorType']
  actorId?: string
  action: string
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
  ipAddress?: string
}

export function addAuditEntry(params: AddAuditEntryParams): AuditEntry {
  const id = generateId()
  const now = new Date().toISOString()
  getDb().insert(auditLog).values({
    id,
    projectId: params.projectId ?? null,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    metadata: JSON.stringify(params.metadata ?? {}),
    ipAddress: params.ipAddress ?? null,
    createdAt: now,
  }).run()
  return getDb().select().from(auditLog).where(eq(auditLog.id, id)).limit(1).all()[0]!
}

export interface ListAuditOpts {
  resourceType?: string
  resourceId?: string
  actorId?: string
  limit?: number
}

export function listAuditLog(projectId: string, opts: ListAuditOpts = {}): AuditEntry[] {
  const db = getDb()
  let query = db.select().from(auditLog).$dynamic()

  const conditions = [eq(auditLog.projectId, projectId)]
  if (opts.resourceType) conditions.push(eq(auditLog.resourceType, opts.resourceType))
  if (opts.resourceId)   conditions.push(eq(auditLog.resourceId, opts.resourceId))
  if (opts.actorId)      conditions.push(eq(auditLog.actorId, opts.actorId))

  query = query.where(and(...conditions)).orderBy(desc(auditLog.createdAt))
  if (opts.limit) query = query.limit(opts.limit)

  return query.all()
}
