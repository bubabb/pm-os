import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import type { AuthenticatedRequest } from '../auth'
import {
  listTools, getTool, createTool,
  listVersions, getToolVersion, publishVersion,
  listDeployments, getActiveDeployment, deploy, rollback,
} from '@pm-os/tool-registry'

interface ProjectParams { id: string }
interface ToolParams    { id: string; toolId: string }
interface VersionParams { id: string; toolId: string; versionId: string }

interface CreateToolBody     { name: string; description?: string }
interface PublishVersionBody { version: string; schema: string; implementation: string; changelog?: string }
interface DeployBody         { versionId: string }

// Confirm a tool belongs to the project in the URL before exposing its versions/deployments.
function toolInProject(toolId: string, projectId: string): boolean {
  const t = getTool(toolId)
  return t !== null && t.projectId === projectId
}

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  // ── Tools ────────────────────────────────────────────────────────────────────

  app.get<{ Params: ProjectParams }>(
    '/projects/:id/tools',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return listTools(request.params.id)
    },
  )

  app.post<{ Params: ProjectParams; Body: CreateToolBody }>(
    '/projects/:id/tools',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: CreateToolBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return createTool(request.params.id, request.body, user.id)
    },
  )

  app.get<{ Params: ToolParams }>(
    '/projects/:id/tools/:toolId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      const tool = getTool(request.params.toolId)
      if (!tool || tool.projectId !== request.params.id) return reply.code(404).send({ error: 'Not found' })
      return tool
    },
  )

  // ── Versions ─────────────────────────────────────────────────────────────────

  app.get<{ Params: ToolParams }>(
    '/projects/:id/tools/:toolId/versions',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      return listVersions(request.params.toolId)
    },
  )

  app.get<{ Params: VersionParams }>(
    '/projects/:id/tools/:toolId/versions/:versionId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: VersionParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      const version = getToolVersion(request.params.versionId)
      if (!version || version.toolId !== request.params.toolId) return reply.code(404).send({ error: 'Not found' })
      return version
    },
  )

  app.post<{ Params: ToolParams; Body: PublishVersionBody }>(
    '/projects/:id/tools/:toolId/versions',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams; Body: PublishVersionBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      try {
        return publishVersion(request.params.toolId, request.body, user.id)
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    },
  )

  // ── Deployments ──────────────────────────────────────────────────────────────

  app.get<{ Params: ToolParams }>(
    '/projects/:id/tools/:toolId/deployments',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      return listDeployments(request.params.toolId)
    },
  )

  app.get<{ Params: ToolParams }>(
    '/projects/:id/tools/:toolId/deployments/active',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      // Wrapped so a null (no active deployment) serializes as JSON instead of an empty body.
      return { deployment: getActiveDeployment(request.params.toolId) }
    },
  )

  app.post<{ Params: ToolParams; Body: DeployBody }>(
    '/projects/:id/tools/:toolId/deploy',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams; Body: DeployBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      try {
        return deploy(request.params.toolId, request.body.versionId, user.id)
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    },
  )

  app.post<{ Params: ToolParams }>(
    '/projects/:id/tools/:toolId/rollback',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ToolParams }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      if (!toolInProject(request.params.toolId, request.params.id)) return reply.code(404).send({ error: 'Not found' })
      try {
        return rollback(request.params.toolId, user.id)
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    },
  )
}
