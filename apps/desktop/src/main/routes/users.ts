import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'crypto'
import { getDb, users } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq } from 'drizzle-orm'
import { requireAuth, requireRole } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface PatchMeBody { name?: string; avatarUrl?: string | null }
interface CreateUserBody { name: string; email?: string }

const EMAIL_MAX_LENGTH = 320
const NAME_MAX_LENGTH = 120

// Public projection of a user — the ONLY columns any /users route returns.
// Deliberately omits avatarUrl/createdAt/updatedAt so GET and POST leak nothing extra.
const publicUserColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
} as const

// Deliberately permissive; just rejects the obviously-malformed. The synthesized
// `<...>@pmos.local` always satisfies this.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Synthesizes a deterministic, INJECTIVE email local-part for an owner with no
// supplied email. The SAME name always maps to the SAME email (idempotent reuse);
// any two DISTINCT trimmed-lowercased names map to DISTINCT emails so they never
// merge onto one shared row. Readability is kept — a readable `<slug>` prefix when
// the name has alphanumerics — but a short stable hash of the FULL normalized name
// is always appended so names that reduce to the same slug (`"Bruna V."` vs
// `"Bruna-V"` vs `"Bruna  V"` all slugify to `bruna-v`) stay distinct. Names with
// no alphanumerics (CJK, punctuation, etc.) fall back to `user-<hash>`. The result
// stays well under the 320-char email limit (slug ≤ NAME_MAX_LENGTH + 9 + domain).
function synthEmailLocal(name: string): string {
  const normalized = name.trim().toLowerCase()
  const hash = createHash('sha1').update(normalized).digest('hex')
  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > 0) return `${slug}-${hash.slice(0, 8)}`
  return `user-${hash.slice(0, 10)}`
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
// Fastify's ajv runs with removeAdditional:true, so additionalProperties:false
// STRIPS unknown keys (role/id) silently before the handler — they never reach
// the DB — and the types reject a null/!string name.
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
  // freeform `owner` to a real user (assigneeId). Ordered by createdAt so the
  // CLI's "first writer wins" name-match is a real, stable contract (not
  // SQLite's unspecified scan order).
  app.get('/users', { preHandler: requireAuth }, async () => {
    return getDb().select(publicUserColumns).from(users).orderBy(users.createdAt)
  })

  // Provision a user by name (+ optional email). Admin-gated — creating users is
  // an administrative action (the dev-stub/OAuth flows both mint admins, so the
  // CLI keeps working). Idempotent: if the email (given or synthesized as
  // <slug>@pmos.local) already exists, the existing user is returned rather than
  // creating a duplicate. Used by `tasks import --create-assignees`.
  app.post<{ Body: CreateUserBody }>(
    '/users',
    { preHandler: [requireAuth, requireRole('admin')], schema: createUserSchema },
    async (request: FastifyRequest<{ Body: CreateUserBody }>, reply) => {
      const db = getDb()
      // minLength:1 runs on the UNTRIMMED string, so a whitespace-only name slips
      // through the schema — reject it here rather than persist a blank name.
      const name = request.body.name.trim()
      if (name.length === 0) return reply.code(400).send({ error: 'name must not be blank' })

      const provided = request.body.email?.trim().toLowerCase() ?? ''
      if (provided.length > 0 && !EMAIL_RE.test(provided)) {
        return reply.code(400).send({ error: 'email is not a valid address' })
      }
      const email = provided.length > 0 ? provided : `${synthEmailLocal(name)}@pmos.local`

      // Atomic idempotent provision. email is UNIQUE, so INSERT ... ON CONFLICT
      // (email) DO NOTHING either creates the row or no-ops when it already exists;
      // the follow-up SELECT then returns that one row either way. This collapses
      // the old check-then-insert TOCTOU into a single atomic write + deterministic
      // read, so concurrent duplicate POSTs can never create two rows regardless of
      // driver or interleaving. Projected columns only (match GET /users — never
      // leak avatarUrl/timestamps).
      await db
        .insert(users)
        .values({ id: generateId(), name, email, role: 'engineer' })
        .onConflictDoNothing({ target: users.email })
      const [user] = await db.select(publicUserColumns).from(users).where(eq(users.email, email)).limit(1)
      return user
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
