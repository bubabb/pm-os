import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { verifyToken } from '../auth'
import { getDb, users } from '@pm-os/database'
import { eq } from 'drizzle-orm'
import type { User } from '@pm-os/database'

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

// EventSource doesn't support custom headers — the SSE endpoint accepts the JWT
// via either the Authorization header (standard) or a `token` query parameter (SSE fallback).
async function resolveSseUser(request: FastifyRequest): Promise<User | null> {
  // Prefer Authorization header; fall back to ?token= query param
  const authHeader = request.headers.authorization
  const queryToken = (request.query as Record<string, string | undefined>)['token']
  const raw = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (queryToken ?? null)

  if (!raw) return null

  const userId = await verifyToken(raw)
  if (!userId) return null

  const db = getDb()
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return user ?? null
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/events/stream',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await resolveSseUser(request)
      if (!user) return reply.code(401).send({ error: 'Unauthorized' })

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

      reply.raw.write(`data: ${JSON.stringify({ type: 'connected', payload: { userId: user.id } })}\n\n`)

      // Heartbeat every 30 seconds to keep alive through proxies
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

      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve)
      })
    },
  )
}
