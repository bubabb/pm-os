import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, projects } from '@pm-os/database'
import { eq, and } from 'drizzle-orm'
import { requireAuth } from '../auth'
import { createSecret, listSecrets, deleteSecret } from '../secrets'
import type { AuthenticatedRequest } from '../auth'

interface ProjectParams { id: string }
interface SecretParams { id: string; secretId: string }
interface CreateSecretBody { name: string; value: string }

export async function secretsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProjectParams }>(
    '/projects/:id/secrets',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .limit(1)
      if (!project) return reply.code(404).send({ error: 'Not found' })
      return listSecrets(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateSecretBody }>(
    '/projects/:id/secrets',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateSecretBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .limit(1)
      if (!project) return reply.code(404).send({ error: 'Not found' })
      const secret = await createSecret(request.params.id, request.body.name, request.body.value)
      // Return without sensitive fields
      const { encryptedValue: _, iv: __, ...safe } = secret
      return safe
    },
  )

  app.delete<{ Params: SecretParams }>(
    '/projects/:id/secrets/:secretId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SecretParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [project] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .limit(1)
      if (!project) return reply.code(404).send({ error: 'Not found' })
      await deleteSecret(request.params.secretId, request.params.id)
      return { ok: true }
    },
  )
}
