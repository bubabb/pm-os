import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import {
  storeIntegrationCredential,
  getIntegrationToken,
  withMergedConnectionMetadata,
  getConnection,
  getConnectionToken,
} from '../secrets'
import { getDb, integrationCredentials, remoteLinks, events } from '@creare/database'
import { and, eq } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import { GitHubConnector, createMirror, pullMirror, getMirrorStatus } from '@creare/integrations'
import type { ConnectorConfig } from '@creare/integrations'
import type { AuthenticatedRequest } from '../auth'

// Bidirectional board mirrors (GitHub Projects v2, Phase 1) — remote-board
// picker, mirror creation (import), manual pull, and sync status. The push
// side is the outbox + push worker (sync/push-worker.ts), not a route.

interface ConnectionParams { connectionId: string }
interface ProjectParams    { id: string }
interface BoardParams      { id: string; boardId: string }

interface CreateMirrorBody { connectionId: string; remoteId: string; label: string }

export async function mirrorsRoutes(app: FastifyInstance): Promise<void> {
  // List the remote boards (GitHub ProjectsV2) this connection's token can
  // access — powers the mirror-source picker. Phase 1 is GitHub-only, so the
  // connector is built directly (same config pattern as the resources route).
  app.get<{ Params: ConnectionParams }>(
    '/connections/:connectionId/remote-boards',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
      const connection = await getConnection(request.params.connectionId)
      if (!connection) return reply.code(404).send({ error: 'Not found' })

      try {
        const token = await getConnectionToken(connection.id)
        const config: ConnectorConfig = {
          credentialId: '',
          projectId: '',
          token,
          metadata: {},
        }
        return await new GitHubConnector(config).listRemoteBoards()
      } catch (err) {
        // Upstream API failure (bad token, missing scope, network, rate limit)
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
      }
    },
  )

  // Create a mirror: bind the connection to this project as an integration
  // credential (token copy), then import the remote ProjectV2 as a new local
  // board.
  app.post<{ Params: ProjectParams; Body: CreateMirrorBody }>(
    '/projects/:id/mirrors',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateMirrorBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const { connectionId, remoteId, label } = request.body

      try {
        const credential = await storeIntegrationCredential({
          projectId: request.params.id,
          source: 'github',
          connectionId,
          label,
          metadata: { projectV2Id: remoteId },
        })
        getDb().insert(events).values({
          id: generateId(),
          type: 'integration.credential.created',
          domain: 'integrations',
          projectId: request.params.id,
          actorType: 'user',
          actorId: user.id,
          resourceType: 'integration_credential',
          resourceId: credential.id,
          payload: JSON.stringify({ source: credential.source, label: credential.label }),
        }).catch((err) => console.error('[creare] Event log write failed:', err))

        const merged = await withMergedConnectionMetadata(credential)
        const token = await getIntegrationToken(credential.id)
        const { boardId } = await createMirror(merged, token, remoteId)
        return { boardId }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
      }
    },
  )

  // Manual pull: reconcile the latest remote state into the mirrored board.
  app.post<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId/pull',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }

      const db = getDb()
      const [boardLink] = await db
        .select()
        .from(remoteLinks)
        .where(and(
          eq(remoteLinks.localType, 'board'),
          eq(remoteLinks.localId, request.params.boardId),
        ))
        .limit(1)
      // Link must exist AND belong to the project in the URL — a plain local
      // board (or another project's board) is simply not mirrored here.
      if (boardLink === undefined || boardLink.projectId !== request.params.id) {
        return reply.code(404).send({ error: 'Board is not mirrored' })
      }

      const [credential] = await db
        .select()
        .from(integrationCredentials)
        .where(eq(integrationCredentials.id, boardLink.credentialId))
        .limit(1)
      if (credential === undefined) {
        return reply.code(404).send({ error: 'Mirror credential not found' })
      }

      try {
        const merged = await withMergedConnectionMetadata(credential)
        const token = await getIntegrationToken(credential.id)
        const { pulled, conflicts } = await pullMirror(merged, token, request.params.boardId)
        return { pulled, conflicts }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
      }
    },
  )

  // Sync status summary for a board (unlinked boards report linked: false —
  // never an error; most boards are local-only).
  app.get<{ Params: BoardParams }>(
    '/projects/:id/boards/:boardId/sync-status',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: BoardParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return await getMirrorStatus(request.params.boardId)
    },
  )
}
