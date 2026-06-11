import { create } from 'zustand'
import { api } from '../lib/api'
import { subscribeToEvent } from '../lib/sse'

interface Notification {
  id: string
  type: string
  title: string
  body: string
  readAt: string | null
  createdAt: string
  projectId: string | null
  resourceType: string | null
  resourceId: string | null
}

interface NotificationsState {
  items: Notification[]
  unreadCount: number
  isOpen: boolean
  load: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: (projectId?: string) => Promise<void>
  setOpen: (open: boolean) => void
  onNewNotification: (n: Notification) => void
}

export const useNotificationsStore = create<NotificationsState>((set, _get) => ({
  items: [],
  unreadCount: 0,
  isOpen: false,

  load: async () => {
    const { items, unreadCount } = await api.get<{ items: Notification[]; unreadCount: number }>(
      '/notifications',
    )
    set({ items, unreadCount })
  },

  markRead: async (id) => {
    await api.patch(`/notifications/${id}/read`, {})
    set((s) => ({
      items: s.items.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }))
  },

  markAllRead: async (projectId) => {
    await api.post('/notifications/read-all', projectId ? { projectId } : {})
    set((s) => ({
      items: s.items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
      unreadCount: 0,
    }))
  },

  setOpen: (open) => set({ isOpen: open }),

  onNewNotification: (n) => {
    set((s) => ({
      items: [n, ...s.items],
      unreadCount: s.unreadCount + 1,
    }))
  },
}))

// Subscribe to real-time notification events
subscribeToEvent('notification.new', (payload) => {
  useNotificationsStore.getState().onNewNotification(payload as Notification)
})
