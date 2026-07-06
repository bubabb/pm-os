import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, users } from '@creare/database'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface PatchMeBody { name?: string; avatarUrl?: string | null }

// Framework-level guard (defense-in-depth atop the explicit whitelist below):
// additionalProperties:false rejects unknown keys (role/email/id → 400) and the
// types reject a null/!string name before it can reach the DB.
const patchMeSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // minLength:1 makes a null/empty name a 400 (Fastify's default ajv coerces
      // null→"" for a string type, so a bare `{ type: 'string' }` would let it slip
      // through as an empty name).
      name: { type: 'string', minLength: 1 },
      avatarUrl: { type: ['string', 'null'] },
    },
  },
} as const

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users/me', { preHandler: requireAuth }, async (request: FastifyRequest) => {
    return (request as AuthenticatedRequest).user
  })

  app.patch<{ Body: PatchMeBody }>(
    '/users/me',
    { preHandler: requireAuth, schema: patchMeSchema },
    async (request: FastifyRequest<{ Body: PatchMeBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      // Whitelist writable fields explicitly — spreading raw request.body would let a
      // client set privileged columns (role, email, id) via mass assignment.
      const body = request.body ?? {}
      const patch: Partial<Pick<typeof users.$inferInsert, 'name' | 'avatarUrl'>> = {}
      // name is NOT NULL — only accept a real string (a raw `{"name":null}` body would
      // otherwise hit the DB constraint and surface as a 500).
      if (typeof body.name === 'string' && body.name.length > 0) patch.name = body.name
      if (body.avatarUrl !== undefined) patch.avatarUrl = body.avatarUrl
      const [updated] = await db
        .update(users)
        .set({ ...patch, updatedAt: new Date().toISOString() })
        .where(eq(users.id, user.id))
        .returning()
      if (!updated) return reply.code(404).send({ error: 'Not found' })
      return updated
    },
  )
}
