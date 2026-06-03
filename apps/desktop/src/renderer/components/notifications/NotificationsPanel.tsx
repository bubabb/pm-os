import { useEffect } from 'react'
import { Bell, Check, CheckCheck } from 'lucide-react'
import { useNotificationsStore } from '../../store/notifications'

const typeLabels: Record<string, string> = {
  approval_needed: 'Approval needed',
  agent_failed: 'Agent failed',
  deployment_complete: 'Deployment complete',
  cost_warning: 'Cost warning',
  mention: 'Mention',
}

export function NotificationsBell() {
  const { unreadCount, setOpen, load } = useNotificationsStore()

  useEffect(() => { load().catch(() => {}) }, [load])

  return (
    <button
      onClick={() => setOpen(true)}
      className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      aria-label="Notifications"
    >
      <Bell className="h-5 w-5" />
      {unreadCount > 0 && (
        <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )
}

export function NotificationsPanel() {
  const { items, isOpen, setOpen, markRead, markAllRead } = useNotificationsStore()

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div className="fixed right-4 top-14 z-50 w-96 rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-card-foreground">Notifications</h2>
          <button
            onClick={() => markAllRead()}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No notifications</p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={`flex gap-3 border-b border-border/50 px-4 py-3 last:border-0 ${
                  !n.readAt ? 'bg-accent/30' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">
                        {typeLabels[n.type] ?? n.type}
                      </span>
                      <p className="text-sm font-medium text-card-foreground">{n.title}</p>
                      <p className="text-xs text-muted-foreground">{n.body}</p>
                    </div>
                    {!n.readAt && (
                      <button
                        onClick={() => markRead(n.id)}
                        className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        aria-label="Mark as read"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/60">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
