import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Github, User, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { QueryError } from '../../components/ui/QueryError'
import { Spinner } from '../../components/ui/Spinner'
import { toast } from '../../components/ui/Toast'

// ── Types ─────────────────────────────────────────────────────────────────────

/** GET /projects/:projectId/conflicts?boardId=<id> */
interface ConflictView {
  id: string
  remoteLinkId: string
  boardId: string
  itemTitle: string
  localSummary: string
  remoteSummary: string
  createdAt: string
}

type Resolution = 'local_wins' | 'remote_wins' | 'dismiss'

const RESOLUTION_TOASTS: Record<Resolution, string> = {
  local_wins: 'Conflict resolved — kept your version',
  remote_wins: 'Conflict resolved — took the remote version',
  dismiss: 'Conflict dismissed',
}

// ── Drawer ────────────────────────────────────────────────────────────────────
// Review-and-resolve UI for bidirectional sync conflicts. This is the
// git-merge moment of the mirror feature, so the copy stays calm and the
// choice is always explicit: keep mine / take theirs / dismiss.

export function ConflictsDrawer({
  open,
  onClose,
  projectId,
  boardId,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  boardId: string
}) {
  const qc = useQueryClient()

  const conflictsQuery = useQuery<ConflictView[]>({
    queryKey: ['conflicts', projectId, boardId],
    queryFn: () => api.get(`/projects/${projectId}/conflicts?boardId=${boardId}`),
    enabled: open,
  })

  const resolve = useMutation({
    mutationFn: ({ conflictId, resolution }: { conflictId: string; resolution: Resolution }) =>
      api.post<{ ok: true }>(`/projects/${projectId}/conflicts/${conflictId}/resolve`, { resolution }),
    onSuccess: (_data, { resolution }) => {
      qc.invalidateQueries({ queryKey: ['conflicts', projectId, boardId] })
      qc.invalidateQueries({ queryKey: ['board-items', boardId] })
      qc.invalidateQueries({ queryKey: ['board-columns', boardId] })
      qc.invalidateQueries({ queryKey: ['sync-status', projectId, boardId] })
      toast.success(RESOLUTION_TOASTS[resolution])
    },
    onError: (e: Error) => toast.error(`Couldn't resolve conflict: ${e.message}`),
  })

  // The conflict currently being resolved — used for per-card busy state.
  const busyId = resolve.isPending ? resolve.variables.conflictId : null

  return (
    <Dialog open={open} onClose={onClose} title="Sync conflicts">
      <p className="mb-4 text-xs text-muted-foreground">
        These items changed in both places since the last sync. Pick which version to keep — nothing
        is overwritten until you decide.
      </p>

      <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
        {conflictsQuery.isPending ? (
          <Spinner />
        ) : conflictsQuery.isError ? (
          <QueryError
            message={conflictsQuery.error instanceof Error ? conflictsQuery.error.message : undefined}
            onRetry={() => void conflictsQuery.refetch()}
          />
        ) : conflictsQuery.data.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No conflicts — everything's in sync."
            description="Changes from both sides have been merged cleanly."
          />
        ) : (
          conflictsQuery.data.map((conflict) => {
            const busy = busyId === conflict.id
            return (
              <div
                key={conflict.id}
                className="rounded-lg border border-border bg-background p-3"
              >
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm font-medium text-foreground" title={conflict.itemTitle}>
                    {conflict.itemTitle}
                  </p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatRelative(conflict.createdAt)}
                  </span>
                </div>

                {/* Two-column comparison: yours vs remote */}
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border bg-card p-2">
                    <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <User className="h-3 w-3" aria-hidden="true" />
                      Yours
                    </p>
                    <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                      {conflict.localSummary}
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-card p-2">
                    <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Github className="h-3 w-3" aria-hidden="true" />
                      GitHub / Remote
                    </p>
                    <p className="whitespace-pre-wrap break-words text-xs text-foreground">
                      {conflict.remoteSummary}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => resolve.mutate({ conflictId: conflict.id, resolution: 'local_wins' })}
                    disabled={resolve.isPending}
                    aria-label={`Keep your version of ${conflict.itemTitle}`}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                  >
                    {busy && <Spinner size="sm" inline className="text-primary-foreground" />}
                    Keep mine
                  </button>
                  <button
                    onClick={() => resolve.mutate({ conflictId: conflict.id, resolution: 'remote_wins' })}
                    disabled={resolve.isPending}
                    aria-label={`Take the remote version of ${conflict.itemTitle}`}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                  >
                    Take theirs
                  </button>
                  <button
                    onClick={() => resolve.mutate({ conflictId: conflict.id, resolution: 'dismiss' })}
                    disabled={resolve.isPending}
                    aria-label={`Dismiss conflict on ${conflict.itemTitle}`}
                    className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                  >
                    <XCircle className="h-3 w-3" aria-hidden="true" />
                    Dismiss
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Dialog>
  )
}
