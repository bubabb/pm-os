import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, projects, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and, isNull } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

interface ProjectParams { id: string }
interface CreateProjectBody { name: string; description?: string }
interface PatchProjectBody { name?: string; description?: string }

function emitProjectEvent(
  db: ReturnType<typeof getDb>,
  type: string,
  projectId: string,
  actorId: string,
  payload: Record<string, unknown> = {},
) {
  // Fire-and-forget — event log writes must not block the API response
  db.insert(events).values({
    id: generateId(),
    type,
    domain: 'projects',
    projectId,
    actorType: 'user',
    actorId,
    resourceType: 'project',
    resourceId: projectId,
    payload: JSON.stringify(payload),
  }).catch((err) => console.error('[creare] Event log write failed:', err))
}

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
      emitProjectEvent(db, 'project.created', project!.id, user.id, { name })
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
      emitProjectEvent(db, 'project.updated', updated.id, user.id, request.body)
      return updated
    },
  )

  app.delete<{ Params: ProjectParams }>(
    '/projects/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [archived] = await db
        .update(projects)
        .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .returning()
      if (!archived) return reply.code(404).send({ error: 'Not found' })
      emitProjectEvent(db, 'project.archived', archived.id, user.id)
      return { ok: true }
    },
  )
}
