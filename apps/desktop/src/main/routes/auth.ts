import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SignJWT } from 'jose'
import { signIn, verifyToken, getJwtSecret } from '../auth'
import { getDb, users, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'

const JWT_ISSUER = 'creare'
const JWT_AUDIENCE = 'creare-desktop'

interface SignInBody { provider: 'github' | 'entra' }

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Phase 1 sign-in: creates or returns a dev user and issues a JWT.
  // Real OAuth browser flow (opening system browser, code exchange) ships in Phase 3.
  app.post<{ Body: SignInBody }>(
    '/auth/sign-in',
    async (request: FastifyRequest<{ Body: SignInBody }>, reply) => {
      const { provider } = request.body
      if (provider !== 'github' && provider !== 'entra') {
        return reply.code(400).send({ error: 'Invalid provider' })
      }

      const user = await signIn(provider)

      const token = await new SignJWT({ sub: user.id })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(getJwtSecret())

      // Write sign-in event — fire-and-forget, projectId is null (cross-project action)
      const db = getDb()
      db.insert(events).values({
        id: generateId(),
        type: 'user.signed_in',
        domain: 'auth',
        projectId: null,
        actorType: 'user',
        actorId: user.id,
        resourceType: 'user',
        resourceId: user.id,
        payload: JSON.stringify({ provider }),
      }).catch((err) => console.error('[creare] Event log write failed:', err))

      return { token, user }
    },
  )

  // Session restore — validates a token and returns the current user
  app.get('/auth/me', async (request: FastifyRequest, reply) => {
    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Unauthorized' })

    const token = auth.slice(7)
    const userId = await verifyToken(token)
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' })

    const db = getDb()
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })

    return user
  })
}
