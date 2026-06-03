import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, users } from '@creare/database'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface PatchMeBody { name?: string; avatarUrl?: string | null }

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users/me', { preHandler: requireAuth }, async (request: FastifyRequest) => {
    return (request as AuthenticatedRequest).user
  })

  app.patch<{ Body: PatchMeBody }>(
    '/users/me',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: PatchMeBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [updated] = await db
        .update(users)
        .set({ ...request.body, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id))
        .returning()
      if (!updated) return reply.code(404).send({ error: 'Not found' })
      return updated
    },
  )
}
