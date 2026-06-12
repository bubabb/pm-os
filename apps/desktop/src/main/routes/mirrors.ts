import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import {
  storeIntegrationCredential,
  deleteIntegrationCredential,
  getIntegrationToken,
  withMergedConnectionMetadata,
  getConnection,
  getConnectionToken,
} from '../secrets'
import { getDb, integrationCredentials, remoteLinks, events } from '@creare/database'
import { and, eq, isNull } from 'drizzle-orm'
import { generateId } from '@creare/shared'
import { listRemoteBoards, resolveRemoteBoard, createMirror, pullMirror, getMirrorStatus } from '@creare/integrations'
import type { ConnectorConfig } from '@creare/integrations'
import type { AuthenticatedRequest } from '../auth'
import type { Connection } from '@creare/database'

// Bidirectional board mirrors (GitHub Projects v2, Phase 1) — remote-board
// picker, mirror creation (import), manual pull, and sync status. The push
// side is the outbox + push worker (sync/push-worker.ts), not a route.

interface ConnectionParams { connectionId: string }
interface ProjectParams    { id: string }
interface BoardParams      { id: string; boardId: string }

interface CreateMirrorBody { connectionId: string; remoteId: string; label: string }
interface ResolveBoardQuery { ref?: string }

// Connection-scoped ConnectorConfig — connections are workspace-global, so the
// credential/project ids are intentionally blank; only the token + metadata
// (baseUrl…) matter to the connector. Shared by the remote-boards and
// resolve-board routes.
function connectionConnectorConfig(connection: Connection, token: string): ConnectorConfig {
  const metadata = (() => {
    try { return JSON.parse(connection.metadata) as Record<string, unknown> }
    catch { return {} }
  })()
  const baseUrl = typeof metadata['baseUrl'] === 'string' ? metadata['baseUrl'] : undefined

  return {
    credentialId: '',
    projectId: '',
    token,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    metadata,
  }
}

export async function mirrorsRoutes(app: FastifyInstance): Promise<void> {
  // List the remote boards this connection's token can access — powers the
  // mirror-source picker. Connector-agnostic: listRemoteBoards dispatches on
  // the connection's source (same config pattern as the resources route);
  // connectors without board-mirror support return [].
  app.get<{ Params: ConnectionParams }>(
    '/connections/:connectionId/remote-boards',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
      const connection = await getConnection(request.params.connectionId)
      if (!connection) return reply.code(404).send({ error: 'Not found' })

      try {
        const token = await getConnectionToken(connection.id)
        return await listRemoteBoards(connection.source, connectionConnectorConfig(connection, token))
      } catch (err) {
        // Upstream API failure (bad token, missing scope, network, rate limit)
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
      }
    },
  )

  // Resolve ONE remote board from its URL — the cross-owner import path. The
  // connection's token can access other users'/orgs' boards it collaborates
  // on, which the "own boards" picker above never lists. Returns the same
  // RemoteBoardOption shape the picker uses, so the UI feeds the resolved id
  // straight into POST /projects/:id/mirrors.
  app.get<{ Params: ConnectionParams; Querystring: ResolveBoardQuery }>(
    '/connections/:connectionId/resolve-board',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams; Querystring: ResolveBoardQuery }>, reply) => {
      const connection = await getConnection(request.params.connectionId)
      if (!connection) return reply.code(404).send({ error: 'Not found' })

      const ref = request.query.ref
      if (!ref) return reply.code(400).send({ error: 'Missing required query parameter "ref" (the project URL)' })

      try {
        const token = await getConnectionToken(connection.id)
        const option = await resolveRemoteBoard(connection.source, connectionConnectorConfig(connection, token), ref)
        if (option === null) {
          // Unparseable URL, nonexistent project, or invisible to this token —
          // GitHub does not distinguish "missing" from "no access".
          return reply.code(404).send({
            error: "Project not found, or your token cannot access it. Make sure the token's account is a collaborator on that project.",
          })
        }
        return option
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

      // Duplicate-import guard: if this project already mirrors this remote
      // board (a live board-level remote link to the same ProjectV2), refuse
      // instead of creating a second credential + board for the same source.
      const [existingLink] = await getDb()
        .select()
        .from(remoteLinks)
        .where(and(
          eq(remoteLinks.projectId, request.params.id),
          eq(remoteLinks.localType, 'board'),
          eq(remoteLinks.remoteId, remoteId),
          isNull(remoteLinks.deletedAt),
        ))
        .limit(1)
      if (existingLink !== undefined) {
        return reply.code(409).send({
          error: 'This GitHub Project is already imported to this project',
          boardId: existingLink.localId,
        })
      }

      let credential
      try {
        credential = await storeIntegrationCredential({
          projectId: request.params.id,
          source: 'github',
          connectionId,
          label,
          metadata: { projectV2Id: remoteId },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
      }
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

      try {
        const merged = await withMergedConnectionMetadata(credential)
        const token = await getIntegrationToken(credential.id)
        const { boardId } = await createMirror(merged, token, remoteId)
        return { boardId }
      } catch (err) {
        // Import failed AFTER the credential row was created — remove it so a
        // retry starts clean instead of accumulating orphaned credentials.
        await deleteIntegrationCredential(credential.id)
          .catch((cleanupErr) => console.error('[creare] Orphaned credential cleanup failed:', cleanupErr))
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
          isNull(remoteLinks.deletedAt),
        ))
        .limit(1)
      // Link must exist, be LIVE (deleteBoard tombstones it — pulling through
      // a tombstone would write into a deleted boardId), AND belong to the
      // project in the URL — otherwise the board is simply not mirrored here.
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
