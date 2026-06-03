import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import {
  listNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
} from '../notifications'
import type { AuthenticatedRequest } from '../auth'

interface NotificationParams { id: string }
interface ReadAllBody { projectId?: string }

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/notifications',
    { preHandler: requireAuth },
    async (request: FastifyRequest) => {
      const user = (request as AuthenticatedRequest).user
      const [items, unreadCount] = await Promise.all([
        listNotifications(user.id, 50),
        getUnreadCount(user.id),
      ])
      return { items, unreadCount }
    },
  )

  app.patch<{ Params: NotificationParams }>(
    '/notifications/:id/read',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: NotificationParams }>) => {
      const user = (request as AuthenticatedRequest).user
      await markAsRead(request.params.id, user.id)
      return { ok: true }
    },
  )

  app.post<{ Body: ReadAllBody }>(
    '/notifications/read-all',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: ReadAllBody }>) => {
      const user = (request as AuthenticatedRequest).user
      await markAllAsRead(user.id, request.body?.projectId)
      return { ok: true }
    },
  )
}
