import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb, projects, events } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { createBoard } from '@pm-os/boards'
import { addEdge, createTask, createWorkspace } from '@pm-os/agent-orchestration'
import { eq, and, isNull, isNotNull } from 'drizzle-orm'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

type TemplateId = 'blank' | 'ai-tool' | 'agent-pipeline'

interface ProjectParams { id: string }
interface ListProjectsQuery { archived?: string }
interface CreateProjectBody { name: string; description?: string; templateId?: TemplateId }
interface PatchProjectBody { name?: string; description?: string }

const NAME_MAX_LENGTH = 120
const DESCRIPTION_MAX_LENGTH = 1000
const TEMPLATE_IDS: readonly TemplateId[] = ['blank', 'ai-tool', 'agent-pipeline']

// Validates and normalizes a project name. Returns the trimmed name, or an
// error message when the name is empty/whitespace or too long.
function validateName(raw: string): { name: string } | { error: string } {
  const name = raw.trim()
  if (name.length === 0) return { error: 'name must not be empty' }
  if (name.length > NAME_MAX_LENGTH) {
    return { error: `name must be at most ${NAME_MAX_LENGTH} characters` }
  }
  return { name }
}

function validateDescription(description: string): string | null {
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`
  }
  return null
}

// Scaffolds the project's initial resources via the domain public APIs.
// Synchronous getDb()-backed calls — safe to invoke directly from the route.
function scaffoldProject(projectId: string, templateId: TemplateId, actorId: string): void {
  if (templateId === 'ai-tool') {
    createBoard(projectId, { name: 'Main Board' }, actorId)
    createWorkspace(
      projectId,
      { name: 'Main Agent', modelProvider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      actorId,
    )
    return
  }

  if (templateId === 'agent-pipeline') {
    const workspace = createWorkspace(
      projectId,
      { name: 'Pipeline Agent', modelProvider: 'anthropic', modelId: 'claude-sonnet-4-6' },
      actorId,
    )
    const steps = ['Step 1', 'Step 2', 'Step 3'].map((title) =>
      createTask(projectId, { title, type: 'agent', agentWorkspaceId: workspace.id }, actorId),
    )
    // Chain Step 1 → Step 2 → Step 3 into a linear 3-node DAG.
    for (let i = 0; i < steps.length - 1; i++) {
      const result = addEdge(projectId, steps[i]!.id, steps[i + 1]!.id, actorId)
      if (!result.ok) {
        throw new Error(`Failed to chain pipeline tasks: ${result.error ?? 'unknown'}`)
      }
    }
  }
}

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
  }).catch((err) => console.error('[pm-os] Event log write failed:', err))
}

export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ListProjectsQuery }>(
    '/projects',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Querystring: ListProjectsQuery }>) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      // ?archived=1 (or =true) lists ONLY archived projects; default is active-only.
      const archivedOnly = request.query.archived === '1' || request.query.archived === 'true'
      return db
        .select()
        .from(projects)
        .where(and(
          eq(projects.ownerId, user.id),
          archivedOnly ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
        ))
    },
  )

  app.post<{ Body: CreateProjectBody }>(
    '/projects',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: CreateProjectBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const { name: rawName, description, templateId = 'blank' } = request.body

      if (typeof rawName !== 'string') {
        return reply.code(400).send({ error: 'name is required' })
      }
      const nameResult = validateName(rawName)
      if ('error' in nameResult) return reply.code(400).send({ error: nameResult.error })
      if (description !== undefined) {
        const descError = validateDescription(description)
        if (descError) return reply.code(400).send({ error: descError })
      }
      if (!TEMPLATE_IDS.includes(templateId)) {
        return reply.code(400).send({ error: `templateId must be one of: ${TEMPLATE_IDS.join(', ')}` })
      }

      const db = getDb()
      const [project] = await db
        .insert(projects)
        .values({ id: generateId(), name: nameResult.name, description: description ?? null, ownerId: user.id })
        .returning()
      emitProjectEvent(db, 'project.created', project!.id, user.id, { name: nameResult.name, templateId })

      // Scaffolding is best-effort — the project must exist even if it fails.
      if (templateId !== 'blank') {
        try {
          scaffoldProject(project!.id, templateId, user.id)
          emitProjectEvent(db, 'project.scaffolded', project!.id, user.id, { templateId })
        } catch (err) {
          console.error('[pm-os] Project scaffolding failed:', err)
        }
      }

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

      // Whitelist: only name and description are patchable — never ownerId,
      // archivedAt, or id. Build the patch with explicit guards so absent keys
      // are never passed as `undefined` (exactOptionalPropertyTypes).
      const { name: rawName, description } = request.body
      const patch: Partial<typeof projects.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      }
      const changed: Record<string, unknown> = {}

      if (rawName !== undefined) {
        const nameResult = validateName(rawName)
        if ('error' in nameResult) return reply.code(400).send({ error: nameResult.error })
        patch.name = nameResult.name
        changed['name'] = nameResult.name
      }
      if (description !== undefined) {
        const descError = validateDescription(description)
        if (descError) return reply.code(400).send({ error: descError })
        patch.description = description
        changed['description'] = description
      }

      const db = getDb()
      const [updated] = await db
        .update(projects)
        .set(patch)
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .returning()
      if (!updated) return reply.code(404).send({ error: 'Not found' })
      emitProjectEvent(db, 'project.updated', updated.id, user.id, changed)
      return updated
    },
  )

  app.post<{ Params: ProjectParams }>(
    '/projects/:id/restore',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      const db = getDb()
      const [restored] = await db
        .update(projects)
        .set({ archivedAt: null, updatedAt: new Date().toISOString() })
        .where(and(eq(projects.id, request.params.id), eq(projects.ownerId, user.id)))
        .returning()
      if (!restored) return reply.code(404).send({ error: 'Not found' })
      emitProjectEvent(db, 'project.restored', restored.id, user.id)
      return restored
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
