import type { FastifyInstance, FastifyRequest } from 'fastify'
import { signIn, verifyToken, createSessionToken, getOAuthConfig, performOAuthFlow, upsertOAuthUser } from '../auth'
import { getDb, users, events } from '@creare/database'
import type { User } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'

interface SignInBody { provider: 'github' | 'entra' }

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Sign-in: real OAuth browser-window flow when the provider is configured via
  // env vars (CREARE_<PROVIDER>_CLIENT_ID/SECRET); otherwise falls back to the
  // Phase 1 dev-user stub so development works without registered OAuth apps.
  app.post<{ Body: SignInBody }>(
    '/auth/sign-in',
    async (request: FastifyRequest<{ Body: SignInBody }>, reply) => {
      const { provider } = request.body
      if (provider !== 'github' && provider !== 'entra') {
        return reply.code(400).send({ error: 'Invalid provider' })
      }

      const oauthConfig = getOAuthConfig(provider)
      let user: User
      let method: 'oauth' | 'dev-stub'
      if (oauthConfig) {
        try {
          const profile = await performOAuthFlow(provider, oauthConfig)
          user = await upsertOAuthUser(profile)
          method = 'oauth'
        } catch (err) {
          const message = err instanceof Error ? err.message : 'OAuth sign-in failed'
          return reply.code(401).send({ error: message })
        }
      } else {
        // No OAuth app configured. The dev-stub mints an ADMIN JWT with no
        // credential, so it is gated behind an explicit opt-in env var and must
        // never be reachable in a real deployment.
        if (process.env['CREARE_DEV_AUTH'] !== '1') {
          return reply.code(401).send({
            error: 'auth_not_configured',
            message: 'OAuth is not configured. Set CREARE_DEV_AUTH=1 for local dev sign-in.',
          })
        }
        user = await signIn(provider)
        method = 'dev-stub'
      }

      const token = await createSessionToken(user.id)

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
        payload: JSON.stringify({ provider, method }),
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
