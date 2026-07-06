import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, users } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface PatchMeBody { name?: string; avatarUrl?: string | null }
interface CreateUserBody { name: string; email?: string }

const EMAIL_MAX_LENGTH = 320
const NAME_MAX_LENGTH = 120

// Turns a freeform owner/display name into a deterministic local-part so the same
// owner always synthesizes the same email (→ idempotent provisioning). Falls back
// to 'user' when the name has no usable characters.
function slugifyEmailLocal(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'user'
}

const createUserSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      // role/id are intentionally NOT accepted — no privilege escalation via create.
      name: { type: 'string', minLength: 1, maxLength: NAME_MAX_LENGTH },
      email: { type: 'string', minLength: 1, maxLength: EMAIL_MAX_LENGTH },
    },
  },
} as const

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

  // List the team. Pm.Os is a local, single-tenant tool, so any authenticated
  // user may see the member roster — this is what lets the CLI resolve a task's
  // freeform `owner` to a real user (assigneeId).
  app.get('/users', { preHandler: requireAuth }, async () => {
    return getDb()
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
  })

  // Provision a user by name (+ optional email). Idempotent: if the email (given
  // or synthesized as <slug>@pmos.local) already exists, the existing user is
  // returned rather than creating a duplicate. Used by `tasks import
  // --create-assignees` to materialize owners that don't match an existing user.
  app.post<{ Body: CreateUserBody }>(
    '/users',
    { preHandler: requireAuth, schema: createUserSchema },
    async (request: FastifyRequest<{ Body: CreateUserBody }>) => {
      const db = getDb()
      const name = request.body.name.trim()
      const email = (request.body.email?.trim() ?? '').toLowerCase()
        || `${slugifyEmailLocal(name)}@pmos.local`

      // email is UNIQUE — reuse an existing row so provisioning is idempotent.
      const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
      if (existing) return existing

      const [created] = await db
        .insert(users)
        .values({ id: generateId(), name, email, role: 'engineer' })
        .returning()
      return created
    },
  )

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
