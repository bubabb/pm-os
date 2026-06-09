import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listTraces, getTrace, createTrace, updateTrace,
  listTraceEvents, addTraceEvent,
  listEventLog, listAuditLog, addAuditEntry,
} from '@creare/observability'
import type {
  Trace, TraceEvent, AuditEntry,
  ListEventsOpts, ListAuditOpts, AddAuditEntryParams,
} from '@creare/observability'

interface ProjectParams  { id: string }
interface TraceParams    { id: string; traceId: string }

interface CreateTraceBody {
  agentWorkspaceId: string
  taskId?: string
}

interface UpdateTraceBody {
  status?: Trace['status']
  inputTokens?: number
  outputTokens?: number
  costCents?: number
  durationMs?: number
  completedAt?: string
}

interface AddTraceEventBody {
  type: TraceEvent['type']
  payload?: Record<string, unknown>
  durationMs?: number
}

interface AddAuditBody {
  actorType: AuditEntry['actorType']
  actorId?: string
  action: string
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
  ipAddress?: string
}

interface ListTracesQuery    { status?: string }
interface ListEventsQuery    { domain?: string; type?: string; resourceType?: string; resourceId?: string; limit?: string }
interface ListAuditQuery     { resourceType?: string; resourceId?: string; actorId?: string; limit?: string }

// Clamp a client-supplied limit to a sane, bounded integer (avoids NaN/0/full-table scans).
function safeLimit(raw?: string): number {
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 100
}

// Confirm a trace belongs to the project in the URL.
function traceInProject(traceId: string, projectId: string): boolean {
  const t = getTrace(traceId)
  return t !== null && t.projectId === projectId
}

export async function observabilityRoutes(app: FastifyInstance): Promise<void> {
  // ── Traces ─────────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListTracesQuery }>(
    '/projects/:id/traces',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListTracesQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const status = request.query.status as Trace['status'] | undefined
      return listTraces(request.params.id, status ? { status } : undefined)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateTraceBody }>(
    '/projects/:id/traces',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateTraceBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const params = {
        projectId: request.params.id,
        agentWorkspaceId: request.body.agentWorkspaceId,
        ...(request.body.taskId ? { taskId: request.body.taskId } : {}),
      }
      return createTrace(params)
    },
  )

  app.get<{ Params: TraceParams }>(
    '/projects/:id/traces/:traceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const trace = getTrace(request.params.traceId)
      if (!trace || trace.projectId !== request.params.id) return reply.code(404).send({ error: 'Trace not found' })
      return trace
    },
  )

  app.patch<{ Params: TraceParams; Body: UpdateTraceBody }>(
    '/projects/:id/traces/:traceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams; Body: UpdateTraceBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!traceInProject(request.params.traceId, request.params.id)) return reply.code(404).send({ error: 'Trace not found' })
      const trace = updateTrace(request.params.traceId, request.body)
      if (!trace) return reply.code(404).send({ error: 'Trace not found' })
      return trace
    },
  )

  app.get<{ Params: TraceParams }>(
    '/projects/:id/traces/:traceId/events',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!traceInProject(request.params.traceId, request.params.id)) return reply.code(404).send({ error: 'Trace not found' })
      return listTraceEvents(request.params.traceId)
    },
  )

  app.post<{ Params: TraceParams; Body: AddTraceEventBody }>(
    '/projects/:id/traces/:traceId/events',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams; Body: AddTraceEventBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!traceInProject(request.params.traceId, request.params.id)) return reply.code(404).send({ error: 'Trace not found' })
      return addTraceEvent(request.params.traceId, request.body)
    },
  )

  // ── Event log ──────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListEventsQuery }>(
    '/projects/:id/event-log',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListEventsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const { domain, type, resourceType, resourceId, limit } = request.query
      const opts: ListEventsOpts = { limit: safeLimit(limit) }
      if (domain)       opts.domain = domain
      if (type)         opts.type = type
      if (resourceType) opts.resourceType = resourceType
      if (resourceId)   opts.resourceId = resourceId
      return listEventLog(request.params.id, opts)
    },
  )

  // ── Audit log ──────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams; Querystring: ListAuditQuery }>(
    '/projects/:id/audit-log',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListAuditQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const { resourceType, resourceId, actorId, limit } = request.query
      const opts: ListAuditOpts = { limit: safeLimit(limit) }
      if (resourceType) opts.resourceType = resourceType
      if (resourceId)   opts.resourceId = resourceId
      if (actorId)      opts.actorId = actorId
      return listAuditLog(request.params.id, opts)
    },
  )

  app.post<{ Params: ProjectParams; Body: AddAuditBody }>(
    '/projects/:id/audit-log',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: AddAuditBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const b = request.body
      const params: AddAuditEntryParams = {
        projectId: request.params.id,
        actorType: b.actorType,
        action: b.action,
        resourceType: b.resourceType,
        resourceId: b.resourceId,
      }
      if (b.actorId)   params.actorId = b.actorId
      if (b.metadata)  params.metadata = b.metadata
      if (b.ipAddress) params.ipAddress = b.ipAddress
      return addAuditEntry(params)
    },
  )
}
