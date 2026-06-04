import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { listIntegrationCredentials, storeIntegrationCredential, deleteIntegrationCredential, getIntegrationToken } from '../secrets'
import { getDb, integrationCredentials, events } from '@creare/database'
import { eq } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import { triggerSync, getSyncStatus, getActiveEvents } from '@creare/integrations'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import type { IntegrationCredential } from '@creare/database'

interface ProjectParams { id: string }
interface CredentialParams { id: string; credentialId: string }

interface CreateCredentialBody {
  source: IntegrationCredential['source']
  label: string
  token: string
  metadata?: Record<string, unknown>
  expiresAt?: string
}

interface SyncBody { source?: IntegrationCredential['source'] }
interface EventsQuery { source?: string; entityType?: string; since?: string }

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // List credentials (no tokens returned)
  app.get<{ Params: ProjectParams }>(
    '/projects/:id/integrations',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return listIntegrationCredentials(request.params.id)
    },
  )

  // Store a new credential
  app.post<{ Params: ProjectParams; Body: CreateCredentialBody }>(
    '/projects/:id/integrations',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateCredentialBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const { source, label, token, metadata, expiresAt } = request.body
      const credential = await storeIntegrationCredential({
        projectId: request.params.id,
        source,
        label,
        token,
        metadata,
        expiresAt,
      })
      // Return without sensitive fields
      const { encryptedToken: _, iv: __, ...safe } = credential
      const db = getDb()
      db.insert(events).values({
        id: generateId(),
        type: 'integration.credential.created',
        domain: 'integrations',
        projectId: request.params.id,
        actorType: 'user',
        actorId: user.id,
        resourceType: 'integration_credential',
        resourceId: safe.id,
        payload: JSON.stringify({ source: safe.source, label: safe.label }),
      }).catch((err) => console.error('[creare] Event log write failed:', err))
      return safe
    },
  )

  // Delete a credential
  app.delete<{ Params: CredentialParams }>(
    '/projects/:id/integrations/:credentialId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: CredentialParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      await deleteIntegrationCredential(request.params.credentialId)
      const db = getDb()
      db.insert(events).values({
        id: generateId(),
        type: 'integration.credential.deleted',
        domain: 'integrations',
        projectId: request.params.id,
        actorType: 'user',
        actorId: user.id,
        resourceType: 'integration_credential',
        resourceId: request.params.credentialId,
        payload: JSON.stringify({}),
      }).catch((err) => console.error('[creare] Event log write failed:', err))
      return { ok: true }
    },
  )

  // Trigger sync for all credentials (or one source)
  app.post<{ Params: ProjectParams; Body: SyncBody }>(
    '/projects/:id/integrations/sync',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: SyncBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }

      const db = getDb()
      const credentials = await db
        .select()
        .from(integrationCredentials)
        .where(eq(integrationCredentials.projectId, request.params.id))

      // Fetch tokens and build credential+token pairs
      const pairs = await Promise.all(
        credentials.map(async (credential) => ({
          credential,
          token: await getIntegrationToken(credential.id),
        })),
      )

      // Fire-and-forget — sync runs in background, response returns immediately
      triggerSync(request.params.id, pairs, request.body?.source).catch((err) => {
        console.error('[creare] Background sync failed:', err instanceof Error ? err.message : err)
      })

      return { ok: true, message: 'Sync started' }
    },
  )

  // Get sync status for all sources
  app.get<{ Params: ProjectParams }>(
    '/projects/:id/integrations/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return getSyncStatus(request.params.id)
    },
  )

  // Get active (non-purged) external events
  app.get<{ Params: ProjectParams; Querystring: EventsQuery }>(
    '/projects/:id/integrations/events',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: EventsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const { source, entityType, since } = request.query
      return getActiveEvents(request.params.id, {
        ...(source ? { sources: [source as IntegrationCredential['source']] } : {}),
        ...(entityType ? { entityTypes: [entityType] } : {}),
        ...(since ? { since } : {}),
      })
    },
  )
}
