import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, projects } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and, isNull } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface ProjectParams { id: string }
interface CreateProjectBody { name: string; description?: string }
interface PatchProjectBody { name?: string; description?: string }

export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/projects', { preHandler: requireAuth }, async (request: FastifyRequest) => {
    const user = (request as AuthenticatedRequest).user
    const db = getDb()
    return db
      .select()
      .from(projects)
      .where(and(eq(projects.ownerId, user.id), isNull(projects.archivedAt)))
  })

  app.post<{ Body: CreateProjectBody }>(
    '/projects',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: CreateProjectBody }>) => {
      const user = (request as AuthenticatedRequest).user
      const { name, description } = request.body
      const db = getDb()
      const [project] = await db
        .insert(projects)
        .values({ id: generateId(), name, description: description ?? null, ownerId: user.id })
        .returning()
      return project
    },
  )

  app.get<{ Params: ProjectParams }>(
    '/projects/:id',
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
      return project
    },
  )

  app.patch<{ Params: ProjectParams; Body: PatchProjectBody }>(
    '/projects/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: PatchProjectBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const patch: Partial<typeof projects.$inferInsert> = {
        updatedAt: new Date().toISOString(),
        ...request.body,
      }
      const [updated] = await db
        .update(projects)
        .set(patch)
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .returning()
      if (!updated) return reply.code(404).send({ error: 'Not found' })
      return updated
    },
  )

  app.delete<{ Params: ProjectParams }>(
    '/projects/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      // Soft-delete via archivedAt
      const [archived] = await db
        .update(projects)
        .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .returning()
      if (!archived) return reply.code(404).send({ error: 'Not found' })
      return { ok: true }
    },
  )
}
