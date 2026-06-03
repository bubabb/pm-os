import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { requireAuth } from '../auth'
import type { AuthenticatedRequest } from '../auth'

export interface SseEvent {
  type: string
  payload: unknown
}

// In-memory registry of active SSE connections keyed by userId
const connections = new Map<string, Set<FastifyReply>>()

export function emitEvent(userId: string, event: SseEvent): void {
  const userConnections = connections.get(userId)
  if (!userConnections) return

  const data = `data: ${JSON.stringify(event)}\n\n`
  const dead = new Set<FastifyReply>()

  for (const reply of userConnections) {
    try {
      reply.raw.write(data)
    } catch {
      dead.add(reply)
    }
  }

  for (const reply of dead) {
    userConnections.delete(reply)
  }
}

export function emitToAll(event: SseEvent): void {
  for (const userId of connections.keys()) {
    emitEvent(userId, event)
  }
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/events/stream',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as AuthenticatedRequest).user

      reply.raw.setHeader('Content-Type', 'text/event-stream')
      reply.raw.setHeader('Cache-Control', 'no-cache')
      reply.raw.setHeader('Connection', 'keep-alive')
      reply.raw.setHeader('X-Accel-Buffering', 'no')
      reply.raw.flushHeaders()

      // Register connection
      if (!connections.has(user.id)) {
        connections.set(user.id, new Set())
      }
      connections.get(user.id)!.add(reply)

      // Send initial connected event
      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', payload: { userId: user.id } })}\n\n`)

      // Heartbeat every 30 seconds to keep the connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n')
        } catch {
          clearInterval(heartbeat)
        }
      }, 30_000)

      // Cleanup on disconnect
      request.raw.on('close', () => {
        clearInterval(heartbeat)
        connections.get(user.id)?.delete(reply)
        if (connections.get(user.id)?.size === 0) {
          connections.delete(user.id)
        }
      })

      // Keep the handler alive — SSE connections are long-lived
      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve)
      })
    },
  )
}
