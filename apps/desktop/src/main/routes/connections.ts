import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { listConnections, storeConnection, updateConnection, deleteConnection, getConnection, getConnectionToken } from '../secrets'
import { listConnectorResources } from '@creare/integrations'
import type { ConnectorConfig } from '@creare/integrations'
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
      const connection = await storeConnection({
        source, label, token,
        ...(metadata !== undefined ? { metadata } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
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

  // List the resources (repos/projects/spaces/databases/folders) this
  // connection's token can access — powers the UI resource picker.
  app.get<{ Params: ConnectionParams }>(
    '/connections/:connectionId/resources',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
      const connection = await getConnection(request.params.connectionId)
      if (!connection) return reply.code(404).send({ error: 'Not found' })

      try {
        const token = await getConnectionToken(connection.id)
        const metadata = (() => {
          try { return JSON.parse(connection.metadata) as Record<string, unknown> }
          catch { return {} }
        })()
        const baseUrl = typeof metadata['baseUrl'] === 'string' ? metadata['baseUrl'] : undefined

        const config: ConnectorConfig = {
          credentialId: '',
          projectId: '',
          token,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          metadata,
        }
        return await listConnectorResources(connection.source, config)
      } catch (err) {
        // Upstream API failure (bad token, network, rate limit) — the UI falls
        // back to manual entry.
        const message = err instanceof Error ? err.message : String(err)
        return reply.code(502).send({ error: message })
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
