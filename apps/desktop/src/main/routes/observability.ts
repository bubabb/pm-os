import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listTraces, getTrace, createTrace, updateTrace,
  listTraceEvents, addTraceEvent,
  listEventLog, listAuditLog,
} from '@creare/observability'
import type { Trace, TraceEvent } from '@creare/observability'

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

interface ListTracesQuery    { status?: string }
interface ListEventsQuery    { domain?: string; type?: string; resourceType?: string; resourceId?: string; limit?: string }
interface ListAuditQuery     { resourceType?: string; resourceId?: string; actorId?: string; limit?: string }

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
      return createTrace({
        projectId: request.params.id,
        agentWorkspaceId: request.body.agentWorkspaceId,
        taskId: request.body.taskId,
      })
    },
  )

  app.get<{ Params: TraceParams }>(
    '/projects/:id/traces/:traceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const trace = getTrace(request.params.traceId)
      if (!trace) return reply.code(404).send({ error: 'Trace not found' })
      return trace
    },
  )

  app.patch<{ Params: TraceParams; Body: UpdateTraceBody }>(
    '/projects/:id/traces/:traceId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams; Body: UpdateTraceBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
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
      return listTraceEvents(request.params.traceId)
    },
  )

  app.post<{ Params: TraceParams; Body: AddTraceEventBody }>(
    '/projects/:id/traces/:traceId/events',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: TraceParams; Body: AddTraceEventBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
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
      return listEventLog(request.params.id, {
        domain,
        type,
        resourceType,
        resourceId,
        limit: limit ? parseInt(limit, 10) : 100,
      })
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
      return listAuditLog(request.params.id, {
        resourceType,
        resourceId,
        actorId,
        limit: limit ? parseInt(limit, 10) : 100,
      })
    },
  )
}
