import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import { recordLearning, listLearnings, recallLearnings } from '@pm-os/memory'
import type { LearningSource, RecordLearningParams, RecallQuery } from '@pm-os/memory'

interface ProjectParams { id: string }

interface ListLearningsQuery {
  q?: string                             // free-text recall query
  tags?: string                          // comma-separated
  source?: string
  limit?: string
}

interface RecordLearningBody {
  source: LearningSource
  title: string
  content: string
  taskId?: string
  tags?: string[]
}

const LEARNING_SOURCES: LearningSource[] = ['agent_run', 'review', 'eval', 'manual']

// Clamp a client-supplied limit to a sane, bounded integer (avoids NaN/0/full-table scans).
function safeLimit(raw?: string): number {
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 100
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  // List or recall learnings. With ?q= / ?tags= the relevance-ranked recall is used;
  // otherwise a plain newest-first list (optionally filtered by ?source=).
  app.get<{ Params: ProjectParams; Querystring: ListLearningsQuery }>(
    '/projects/:id/learnings',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListLearningsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })

      const { q, tags, source } = request.query
      const limit = safeLimit(request.query.limit)

      if (source && !LEARNING_SOURCES.includes(source as LearningSource)) {
        return reply.code(400).send({ error: `source must be one of: ${LEARNING_SOURCES.join(', ')}` })
      }

      const wantTags = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : []
      if (q?.trim() || wantTags.length > 0) {
        const query: RecallQuery = { limit }
        if (q?.trim()) query.text = q.trim()
        if (wantTags.length > 0) query.tags = wantTags
        return recallLearnings(request.params.id, query)
      }

      return listLearnings(request.params.id, {
        limit,
        ...(source ? { source: source as LearningSource } : {}),
      })
    },
  )

  // Record a learning. The memory package emits the append-only event-log entry.
  app.post<{ Params: ProjectParams; Body: RecordLearningBody }>(
    '/projects/:id/learnings',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: RecordLearningBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })

      const b = request.body
      if (!b || !LEARNING_SOURCES.includes(b.source)) {
        return reply.code(400).send({ error: `source must be one of: ${LEARNING_SOURCES.join(', ')}` })
      }
      if (typeof b.title !== 'string' || !b.title.trim()) return reply.code(400).send({ error: 'Missing title' })
      if (typeof b.content !== 'string' || !b.content.trim()) return reply.code(400).send({ error: 'Missing content' })
      if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))) {
        return reply.code(400).send({ error: 'tags must be an array of strings' })
      }

      const params: RecordLearningParams = {
        source: b.source,
        title: b.title.trim(),
        content: b.content.trim(),
      }
      if (b.taskId) params.taskId = b.taskId
      if (b.tags)   params.tags = b.tags.map((t) => t.trim()).filter(Boolean)

      try {
        return recordLearning(request.params.id, params, user.id)
      } catch {
        return reply.code(500).send({ error: 'Failed to record learning' })
      }
    },
  )
}
