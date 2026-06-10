import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { getDashboard, queryProject } from '@creare/reporting'
import { getLatestDigest, generatePmDigest, getActiveEvents, classifyItems } from '@creare/integrations'
import { getGlobalSetting } from '../secrets'
import { assertProjectAccess } from '../utils/project-access'
import { createTask } from '@creare/agent-orchestration'
import type { AuthenticatedRequest } from '../auth'
import type { ClassifiedItem } from '@creare/integrations'
import type { PmDigestCache } from '@creare/database'

interface ProjectParams { id: string }
interface DigestParams { id: string; type: string }
interface DelegateBody { entity: ClassifiedItem['entity']; suggestedAction: string }
interface QueryQuery { q: string }

async function getProjectAndApiKey(
  projectId: string,
  userId: string,
): Promise<{ apiKey: string | null } | null> {
  const project = await assertProjectAccess(projectId, userId)
  if (!project) return null

  // The Claude API key is a workspace-level setting — not per-project.
  const apiKey = await getGlobalSetting('ANTHROPIC_API_KEY')
  return { apiKey }
}

export async function reportingRoutes(app: FastifyInstance): Promise<void> {
  // Full PM Command Center dashboard
  app.get<{ Params: ProjectParams }>(
    '/projects/:id/dashboard',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const ctx = await getProjectAndApiKey(request.params.id, user.id)
      if (!ctx) return reply.code(404).send({ error: 'Not found' })
      return getDashboard(request.params.id, ctx.apiKey)
    },
  )

  // Trigger background digest generation for a specific type
  app.get<{ Params: DigestParams }>(
    '/projects/:id/dashboard/digest/:type',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: DigestParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const ctx = await getProjectAndApiKey(request.params.id, user.id)
      if (!ctx) return reply.code(404).send({ error: 'Not found' })

      const validTypes: PmDigestCache['digestType'][] = [
        'morning_brief', 'sprint_health', 'decisions_and_docs', 'risk_radar',
      ]
      const digestType = request.params.type as PmDigestCache['digestType']
      if (!validTypes.includes(digestType)) {
        return reply.code(400).send({ error: 'Invalid digest type' })
      }

      // Return cached if valid
      const cached = await getLatestDigest(request.params.id, digestType)
      if (cached && cached.validUntil > new Date().toISOString()) {
        return cached
      }

      // Generate fresh — requires API key
      if (!ctx.apiKey) {
        return reply.code(422).send({ error: 'ANTHROPIC_API_KEY not configured' })
      }

      const events = await getActiveEvents(request.params.id)
      const items  = events.length > 0 ? await classifyItems(events, ctx.apiKey) : []
      return generatePmDigest(request.params.id, digestType, items, ctx.apiKey)
    },
  )

  // Record a delegation — creates a real agent task via Domain 1
  app.post<{ Params: ProjectParams; Body: DelegateBody }>(
    '/projects/:id/dashboard/delegate',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: DelegateBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }

      const { entity, suggestedAction } = request.body
      try {
        const task = createTask(
          request.params.id,
          {
            title: `[Agent] ${entity.title}`,
            description: `${suggestedAction}\n\nSource: ${entity.source} · ${entity.entityType}\nURL: ${entity.entityUrl ?? 'n/a'}`,
            type: 'agent',
            priority: 'medium',
          },
          user.id,
        )
        return { ok: true, taskId: task.id }
      } catch {
        return reply.code(500).send({ error: 'Failed to create agent task' })
      }
    },
  )

  // NL query
  app.get<{ Params: ProjectParams; Querystring: QueryQuery }>(
    '/projects/:id/reports/query',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: QueryQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const ctx = await getProjectAndApiKey(request.params.id, user.id)
      if (!ctx) return reply.code(404).send({ error: 'Not found' })
      if (!ctx.apiKey) return reply.code(422).send({ error: 'ANTHROPIC_API_KEY not configured' })
      if (!request.query.q?.trim()) return reply.code(400).send({ error: 'Missing q param' })

      const answer = await queryProject(request.params.id, request.query.q, ctx.apiKey)
      return { question: request.query.q, answer }
    },
  )
}
