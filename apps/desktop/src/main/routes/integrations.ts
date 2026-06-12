import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { listIntegrationCredentials, storeIntegrationCredential, deleteIntegrationCredential, getIntegrationToken, withMergedConnectionMetadata } from '../secrets'
import { getDb, integrationCredentials, events } from '@creare/database'
import { eq } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import { triggerSync, getSyncStatus, getActiveEvents } from '@creare/integrations'
import { assertProjectAccess } from '../utils/project-access'
import { createNotification } from '../notifications/notification-service'
import type { AuthenticatedRequest } from '../auth'
import type { IntegrationCredential } from '@creare/database'

interface ProjectParams { id: string }
interface CredentialParams { id: string; credentialId: string }

// Source-binding shape: a per-project source references a global connection
// and carries only the resource scope (e.g. { owner, repo }) — never a token.
interface CreateCredentialBody {
  source: IntegrationCredential['source']
  connectionId: string
  label: string
  metadata?: Record<string, unknown>
}

interface SyncBody { source?: IntegrationCredential['source'] }
interface EventsQuery { source?: string; entityType?: string; since?: string }
interface BulkCreateBody { items: CreateCredentialBody[] }

// Builds credential+token pairs for the project and triggers a sync for one
// source. Callers fire-and-forget this (never await in a request handler).
async function syncProjectSource(
  projectId: string,
  source: IntegrationCredential['source'],
): Promise<void> {
  const db = getDb()
  const credentials = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.projectId, projectId))

  const pairs = await Promise.all(
    credentials.map(async (credential) => ({
      credential: await withMergedConnectionMetadata(credential),
      token: await getIntegrationToken(credential.id),
    })),
  )

  await triggerSync(projectId, pairs, source)
}

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // List credentials (no tokens returned), enriched with per-credential sync state
  app.get<{ Params: ProjectParams }>(
    '/projects/:id/integrations',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const credentials = await listIntegrationCredentials(request.params.id)
      const statuses = await getSyncStatus(request.params.id)
      const statusByCredentialId = new Map(statuses.map((s) => [s.credentialId, s]))
      return credentials.map((row) => {
        const syncState = statusByCredentialId.get(row.id)
        return {
          ...row,
          lastSyncedAt: syncState?.lastSyncedAt ?? null,
          syncStatus: syncState?.status ?? 'idle',
          syncError: syncState?.lastErrorMessage ?? null,
        }
      })
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
      const { source, connectionId, label, metadata } = request.body
      const credential = await storeIntegrationCredential({
        projectId: request.params.id,
        source,
        connectionId,
        label,
        ...(metadata !== undefined ? { metadata } : {}),
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
      // Fire-and-forget — a notification failure never blocks the response.
      createNotification({
        userId: user.id,
        projectId: request.params.id,
        type: 'mention',
        title: 'Source connected',
        body: `${safe.label} (${safe.source}) bound — syncing…`,
        resourceType: 'integration_credential',
        resourceId: safe.id,
      }).catch(console.error)
      // Fire-and-forget — first sync starts immediately instead of waiting for
      // the 15-min poll; the response returns without blocking on it.
      syncProjectSource(request.params.id, source).catch(console.error)
      return safe
    },
  )

  // Bulk-store credentials (multi-select source binding)
  app.post<{ Params: ProjectParams; Body: BulkCreateBody }>(
    '/projects/:id/integrations/bulk',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: BulkCreateBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const items = request.body?.items
      if (!Array.isArray(items) || items.length === 0) {
        return reply.code(400).send({ error: 'items must be a non-empty array' })
      }

      const db = getDb()
      const created: Array<Omit<IntegrationCredential, 'encryptedToken' | 'iv'>> = []
      const failed: Array<{ label: string; error: string }> = []

      // Per-item try/catch — one bad item never aborts the rest of the batch
      for (const item of items) {
        try {
          const credential = await storeIntegrationCredential({
            projectId: request.params.id,
            source: item.source,
            connectionId: item.connectionId,
            label: item.label,
            ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
          })
          const { encryptedToken: _, iv: __, ...safe } = credential
          created.push(safe)
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
        } catch (err) {
          failed.push({
            label: item.label,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Fire-and-forget one sync per distinct source that got a new credential
      const distinctSources = [...new Set(created.map((c) => c.source))]
      for (const source of distinctSources) {
        syncProjectSource(request.params.id, source).catch(console.error)
      }

      // One summarizing notification for the whole batch (no per-item spam).
      // Deep-links to the credential only when exactly one was created.
      if (created.length > 0) {
        const only = created.length === 1 ? created[0] : undefined
        createNotification({
          userId: user.id,
          projectId: request.params.id,
          type: 'mention',
          title: created.length === 1 ? 'Source connected' : 'Sources connected',
          body: `${created.length} source${created.length === 1 ? '' : 's'} bound (${distinctSources.join(', ')}) — syncing…`,
          ...(only ? { resourceType: 'integration_credential', resourceId: only.id } : {}),
        }).catch(console.error)
      }

      return { created, failed }
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
      const db = getDb()
      // IDOR guard: the credential must belong to the project in the URL — a
      // credentialId from another project is indistinguishable from a missing one.
      const [credential] = await db
        .select({ id: integrationCredentials.id, projectId: integrationCredentials.projectId })
        .from(integrationCredentials)
        .where(eq(integrationCredentials.id, request.params.credentialId))
        .limit(1)
      if (credential === undefined || credential.projectId !== request.params.id) {
        return reply.code(404).send({ error: 'Not found' })
      }
      await deleteIntegrationCredential(credential.id)
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

      // Fetch tokens and build credential+token pairs. The credential passed to
      // sync gets the connection's account metadata merged with the per-project
      // scope (shallow clone — the DB row is never mutated).
      const pairs = await Promise.all(
        credentials.map(async (credential) => ({
          credential: await withMergedConnectionMetadata(credential),
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
      const rows = await getActiveEvents(request.params.id, {
        ...(source ? { sources: [source as IntegrationCredential['source']] } : {}),
        ...(entityType ? { entityTypes: [entityType] } : {}),
        ...(since ? { since } : {}),
      })
      // Normalize: the cache row stores the entity fields (title/status/updatedAt)
      // inside the stringified `payload`. The UI reads them top-level, so flatten
      // them here (and never let a bad payload throw — fall back to safe defaults).
      return rows.map((r) => {
        let p: { title?: string; status?: string; updatedAt?: string | null } = {}
        try { p = JSON.parse(r.payload) as typeof p } catch { /* keep defaults */ }
        return {
          entityType: r.entityType,
          entityId: r.entityId,
          entityUrl: r.entityUrl,
          title: p.title ?? r.entityId,
          status: p.status ?? 'unknown',
          updatedAt: p.updatedAt ?? r.fetchedAt,
        }
      })
    },
  )
}
