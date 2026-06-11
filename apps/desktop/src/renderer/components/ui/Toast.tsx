import { create } from 'zustand'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── Global toast system ───────────────────────────────────────────────────────
// Module-level Zustand store + imperative `toast.*` API, rendered by a single
// <ToastViewport/> mounted at the app root. No deps beyond what's installed.

type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastState {
  toasts: ToastItem[]
  push: (kind: ToastKind, message: string) => void
  dismiss: (id: number) => void
}

const AUTO_DISMISS_MS = 4000
let nextId = 0

const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (kind, message) => {
    const id = ++nextId
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, AUTO_DISMISS_MS)
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Imperative API — usable from anywhere (components, stores, mutation handlers). */
export const toast = {
  success: (message: string) => useToastStore.getState().push('success', message),
  error: (message: string) => useToastStore.getState().push('error', message),
  info: (message: string) => useToastStore.getState().push('info', message),
}

const KIND_BORDER: Record<ToastKind, string> = {
  success: 'border-emerald-500/40',
  error: 'border-destructive/40',
  info: 'border-border',
}

const KIND_ICON: Record<ToastKind, { Icon: LucideIcon; className: string }> = {
  success: { Icon: CheckCircle2, className: 'text-emerald-400' },
  error: { Icon: AlertCircle, className: 'text-destructive' },
  info: { Icon: Info, className: 'text-muted-foreground' },
}

/** Bottom-right toast stack. Mount exactly once, at the app root. */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { Icon, className } = KIND_ICON[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            aria-live="polite"
            className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card p-3 shadow-xl ${KIND_BORDER[t.kind]}`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />
            <p className="flex-1 text-sm text-foreground">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="-mr-0.5 -mt-0.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
