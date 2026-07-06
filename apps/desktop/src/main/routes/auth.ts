import type { FastifyInstance, FastifyRequest } from 'fastify'
import { signIn, verifyToken, createSessionToken, getOAuthConfig, performOAuthFlow, upsertOAuthUser } from '../auth'
import { getDb, users, events } from '@pm-os/database'
import type { User } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq } from 'drizzle-orm'

interface SignInBody { provider: 'github' | 'entra' }

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Sign-in. Headless Pm.Os signs in via the dev-stub (interactive OAuth needs a
  // desktop browser window — see oauth-service). The dev-stub mints an ADMIN JWT with
  // no credential, so it is gated behind an explicit PMOS_DEV_AUTH=1 opt-in and takes
  // PRECEDENCE — a stray PMOS_<PROVIDER>_CLIENT_ID env var can't lock out local sign-in
  // by routing to an OAuth flow that can't complete headless.
  app.post<{ Body: SignInBody }>(
    '/auth/sign-in',
    async (request: FastifyRequest<{ Body: SignInBody }>, reply) => {
      const { provider } = request.body
      if (provider !== 'github' && provider !== 'entra') {
        return reply.code(400).send({ error: 'Invalid provider' })
      }

      let user: User
      let method: 'oauth' | 'dev-stub'
      if (process.env['PMOS_DEV_AUTH'] === '1') {
        user = await signIn(provider)
        method = 'dev-stub'
      } else {
        const oauthConfig = getOAuthConfig(provider)
        if (!oauthConfig) {
          return reply.code(401).send({
            error: 'auth_not_configured',
            message:
              'Sign-in is not configured. Set PMOS_DEV_AUTH=1 for local dev sign-in, or authenticate connectors with a Personal Access Token.',
          })
        }
        try {
          const profile = await performOAuthFlow(provider, oauthConfig)
          user = await upsertOAuthUser(profile)
          method = 'oauth'
        } catch (err) {
          const message = err instanceof Error ? err.message : 'OAuth sign-in failed'
          return reply.code(401).send({ error: message })
        }
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
      }).catch((err) => console.error('[pm-os] Event log write failed:', err))

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
