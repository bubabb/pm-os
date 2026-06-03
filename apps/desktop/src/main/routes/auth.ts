import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SignJWT } from 'jose'
import { signIn, verifyToken, getJwtSecret } from '../auth'
import { getDb, users } from '@creare/database'
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
