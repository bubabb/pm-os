import { X, Bot, Loader2, CheckCircle2, ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClassifiedItem } from '@pm-os/integrations'

const SOURCE_LABELS: Record<string, string> = {
  jira: 'Jira', github: 'GitHub', confluence: 'Confluence',
  notion: 'Notion', onedrive: 'OneDrive',
}

interface Props {
  item: ClassifiedItem
  /** Resolves when the agent task is created; rejects on failure (parent toasts the error). */
  onConfirm: (action: string) => Promise<void>
  /** Close the drawer and navigate to Agents → Tasks. */
  onViewAgents: () => void
  onClose: () => void
}

export function DelegateConfigDrawer({ item, onConfirm, onViewAgents, onClose }: Props) {
  const [action, setAction] = useState(item.suggestedAction)
  const [isSending, setIsSending] = useState(false)
  const [isDone, setIsDone] = useState(false)
  const actionInputRef = useRef<HTMLTextAreaElement>(null)

  // Read onClose through a ref so the focus effect below does NOT depend on its
  // identity. The parent passes an inline `onClose`, which changes every parent
  // render (e.g. dashboard refresh, mutation state flips); if the effect depended
  // on it, each of those re-renders would re-run the effect and `.focus()` would
  // steal focus mid-interaction (same class of bug as the Dialog focus trap).
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Dialog behavior: focus the first input on open (mount), close on Escape
  useEffect(() => {
    actionInputRef.current?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  async function handleConfirm() {
    setIsSending(true)
    try {
      await onConfirm(action)
      setIsDone(true)
    } catch {
      // Parent's mutation onError already toasts — keep the form open to retry.
    } finally {
      setIsSending(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-background/50 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delegate-drawer-title"
        className="fixed right-0 top-0 z-50 flex h-full w-96 flex-col border-l border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 id="delegate-drawer-title" className="text-sm font-semibold text-card-foreground">Delegate to Agent</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close delegate drawer"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        {isDone ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-5 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-card-foreground">Agent task created</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                “{item.entity.title}” is now queued in Agents → Tasks. Automated execution is
                coming; for now the task is tracked there.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
            {/* Item summary */}
            <div className="rounded-lg border border-border bg-background p-3 space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {SOURCE_LABELS[item.entity.source] ?? item.entity.source} · {item.entity.entityType}
              </p>
              <p className="text-sm font-medium text-foreground">{item.entity.title}</p>
              {item.entity.entityUrl && (
                <a href={item.entity.entityUrl} target="_blank" rel="noreferrer"
                  className="text-[11px] text-primary/70 hover:text-primary hover:underline">
                  View source ↗
                </a>
              )}
            </div>

            {/* Action instruction */}
            <div>
              <label htmlFor="delegate-action" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                What should the agent do?
              </label>
              <textarea
                id="delegate-action"
                ref={actionInputRef}
                value={action}
                onChange={(e) => setAction(e.target.value)}
                rows={4}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary resize-none"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Creates an agent task in the queue. (Automated execution is coming; for now
                it&apos;s tracked in Agents → Tasks.)
              </p>
            </div>

            {/* Risk type */}
            {item.riskType && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
                <span className="text-xs font-medium text-destructive">Risk: {item.riskType}</span>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        {isDone ? (
          <div className="border-t border-border px-5 py-4 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Done
            </button>
            <button
              onClick={onViewAgents}
              aria-label="View the created task in Agents"
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              View in Agents
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="border-t border-border px-5 py-4 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-lg border border-border py-2 text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!action.trim() || isSending}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
              {isSending ? 'Delegating…' : 'Confirm & Delegate'}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
