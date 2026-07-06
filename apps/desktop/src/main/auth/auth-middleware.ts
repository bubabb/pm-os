import type { FastifyRequest, FastifyReply } from 'fastify'
import { getDb, users } from '@pm-os/database'
import { eq } from 'drizzle-orm'
import { verifyToken } from './auth-service'
import type { User } from '@pm-os/database'

export interface AuthenticatedRequest extends FastifyRequest {
  user: User
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  const token = auth.slice(7)
  const userId = await verifyToken(token)
  if (!userId) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  const db = getDb()
  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!result[0]) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  ;(request as AuthenticatedRequest).user = result[0]
}

export function requireRole(role: User['role']) {
  const roleRank: Record<User['role'], number> = { viewer: 0, pm: 1, engineer: 2, admin: 3 }

  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = (request as AuthenticatedRequest).user
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    if ((roleRank[user.role] ?? -1) < (roleRank[role] ?? 99)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
  }
}
