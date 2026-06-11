import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import { getIntegrationToken, withMergedConnectionMetadata } from '../secrets'
import { getDb, integrationCredentials, syncConflicts } from '@creare/database'
import { eq } from 'drizzle-orm'
import { listOpenConflicts, resolveConflict } from '@creare/integrations'
import type { ConflictResolution } from '@creare/integrations'
import type { IntegrationCredential } from '@creare/database'
import type { AuthenticatedRequest } from '../auth'

// Sync-conflict surface (bidirectional mirrors): list a project's open
// conflicts in human-readable form and apply the user's verdict
// (local_wins / remote_wins / dismiss). The conflict rows themselves are
// written by the pull/push sides — never by these routes.

interface ProjectParams  { id: string }
interface ConflictParams { id: string; conflictId: string }

interface ConflictsQuery { boardId?: string }
interface ResolveBody    { resolution?: unknown }

const RESOLUTIONS: readonly ConflictResolution[] = ['local_wins', 'remote_wins', 'dismiss']

function isResolution(value: unknown): value is ConflictResolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value)
}

// Credential row + decrypted token for resolveConflict — exactly the resolver
// shape the push worker uses (withMergedConnectionMetadata merges the global
// connection's account metadata with the per-project scope).
async function getCredential(
  credentialId: string,
): Promise<{ credential: IntegrationCredential; token: string }> {
  const [row] = await getDb()
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId))
    .limit(1)
  if (row === undefined) {
    throw new Error(`conflicts: integration credential ${credentialId} not found`)
  }
  return {
    credential: await withMergedConnectionMetadata(row),
    token: await getIntegrationToken(row.id),
  }
}

export async function conflictsRoutes(app: FastifyInstance): Promise<void> {
  // Open conflicts for a project, oldest first. Optional ?boardId= narrows to
  // one mirrored board (unknown/unmirrored boardId yields []).
  app.get<{ Params: ProjectParams; Querystring: ConflictsQuery }>(
    '/projects/:id/conflicts',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ConflictsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return await listOpenConflicts(request.params.id, request.query.boardId)
    },
  )

  // Apply the user's verdict on an open conflict.
  app.post<{ Params: ConflictParams; Body: ResolveBody }>(
    '/projects/:id/conflicts/:conflictId/resolve',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConflictParams; Body: ResolveBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) {
        return reply.code(404).send({ error: 'Not found' })
      }

      const resolution = request.body?.resolution
      if (!isResolution(resolution)) {
        return reply.code(400).send({
          error: `resolution must be one of: ${RESOLUTIONS.join(', ')}`,
        })
      }

      // IDOR guard: the conflict must belong to the project in the URL — a
      // conflictId from another project is indistinguishable from a missing one.
      const [conflict] = await getDb()
        .select({ id: syncConflicts.id, projectId: syncConflicts.projectId })
        .from(syncConflicts)
        .where(eq(syncConflicts.id, request.params.conflictId))
        .limit(1)
      if (conflict === undefined || conflict.projectId !== request.params.id) {
        return reply.code(404).send({ error: 'Not found' })
      }

      try {
        await resolveConflict(request.params.conflictId, resolution, getCredential)
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // resolveConflict throws a clear "no sync conflict with id" Error for
        // an unknown id — surface that as a 404, everything else as upstream.
        if (message.includes('no sync conflict with id')) {
          return reply.code(404).send({ error: 'Not found' })
        }
        return reply.code(502).send({ error: message })
      }
    },
  )
}
