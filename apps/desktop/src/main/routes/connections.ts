import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { listConnections, storeConnection, updateConnection, deleteConnection } from '../secrets'
import type { Connection } from '@creare/database'

// Workspace-level (GLOBAL) tool connections — requireAuth, but NOT project-scoped.

interface ConnectionParams { connectionId: string }

interface CreateConnectionBody {
  source: Connection['source']
  label: string
  token: string
  metadata?: Record<string, unknown>
  expiresAt?: string
}

interface UpdateConnectionBody {
  label?: string
  token?: string
  metadata?: Record<string, unknown>
  expiresAt?: string | null
}

export async function connectionsRoutes(app: FastifyInstance): Promise<void> {
  // List connections (no tokens returned)
  app.get(
    '/connections',
    { preHandler: requireAuth },
    async () => {
      return listConnections()
    },
  )

  // Store a new connection
  app.post<{ Body: CreateConnectionBody }>(
    '/connections',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: CreateConnectionBody }>) => {
      const { source, label, token, metadata, expiresAt } = request.body
      const connection = await storeConnection({ source, label, token, metadata, expiresAt })
      // Return without sensitive fields
      const { encryptedToken: _, iv: __, ...safe } = connection
      return safe
    },
  )

  // Update a connection (re-encrypts token if provided)
  app.patch<{ Params: ConnectionParams; Body: UpdateConnectionBody }>(
    '/connections/:connectionId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams; Body: UpdateConnectionBody }>, reply) => {
      const { label, token, metadata, expiresAt } = request.body ?? {}
      try {
        const connection = await updateConnection(request.params.connectionId, {
          ...(label !== undefined ? { label } : {}),
          ...(token !== undefined ? { token } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        })
        // Return without sensitive fields
        const { encryptedToken: _, iv: __, ...safe } = connection
        return safe
      } catch {
        return reply.code(404).send({ error: 'Not found' })
      }
    },
  )

  // Delete a connection
  app.delete<{ Params: ConnectionParams }>(
    '/connections/:connectionId',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams }>) => {
      await deleteConnection(request.params.connectionId)
      return { ok: true }
    },
  )
}
