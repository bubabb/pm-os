import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUp, ExternalLink, Github, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { formatRelative } from '../../lib/format'
import { Spinner } from '../../components/ui/Spinner'
import { toast } from '../../components/ui/Toast'
import { ConflictsDrawer } from './ConflictsDrawer'

// ── Types ─────────────────────────────────────────────────────────────────────

/** GET /projects/:projectId/boards/:boardId/sync-status */
interface SyncStatus {
  linked: boolean
  source: string | null
  remoteUrl: string | null
  lastPulledAt: string | null
  pendingPushes: number
  openConflicts: number
  failedPushes: number
}

/** POST /projects/:projectId/boards/:boardId/pull */
interface PullResult {
  pulled: number
  conflicts: number
}

// ── Chip ──────────────────────────────────────────────────────────────────────
// Compact mirror-status row for the active board. Renders nothing for plain
// (non-mirrored) Creare boards. Polls sync-status every 30s; pulls are manual
// via the "Pull now" button (no auto-pull — see BoardsPage note).

export function MirrorStatusChip({ projectId, boardId }: { projectId: string; boardId: string }) {
  const qc = useQueryClient()
  const [showConflicts, setShowConflicts] = useState(false)

  const { data: status } = useQuery<SyncStatus>({
    queryKey: ['sync-status', projectId, boardId],
    queryFn: () => api.get(`/projects/${projectId}/boards/${boardId}/sync-status`),
    refetchInterval: 30_000,
  })

  const pull = useMutation({
    mutationFn: () =>
      api.post<PullResult>(`/projects/${projectId}/boards/${boardId}/pull`, {}),
    onSuccess: ({ pulled, conflicts }) => {
      qc.invalidateQueries({ queryKey: ['board-items', boardId] })
      qc.invalidateQueries({ queryKey: ['board-columns', boardId] })
      qc.invalidateQueries({ queryKey: ['sync-status', projectId, boardId] })
      toast.success(
        conflicts > 0
          ? `Pulled ${pulled} change${pulled === 1 ? '' : 's'} — ${conflicts} conflict${conflicts === 1 ? '' : 's'} need review`
          : `Pulled ${pulled} change${pulled === 1 ? '' : 's'}`,
      )
    },
    onError: (e: Error) => toast.error(`Pull failed: ${e.message}`),
  })

  // Plain Creare board (or status still loading / unavailable) — render nothing.
  if (!status?.linked) return null

  const sourceLabel = status.source === 'github' ? 'GitHub Project'
    : status.source === 'jira' ? 'Jira project'
    : status.source === 'notion' ? 'Notion database'
    : 'Mirrored board'

  return (
    <div
      role="status"
      aria-label="Mirror status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-1.5"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Github className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        {sourceLabel}
        {status.remoteUrl && (
          <a
            href={status.remoteUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open mirrored project on GitHub"
            className="rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </span>

      <span className="text-[11px] text-muted-foreground">
        {status.lastPulledAt ? `Last synced ${formatRelative(status.lastPulledAt)}` : 'Never synced'}
      </span>

      {status.pendingPushes > 0 && (
        <span
          aria-label={`${status.pendingPushes} pending push${status.pendingPushes === 1 ? '' : 'es'}`}
          className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          <ArrowUp className="h-2.5 w-2.5" aria-hidden="true" />
          {status.pendingPushes}
        </span>
      )}

      {status.openConflicts > 0 && (
        <button
          onClick={() => setShowConflicts(true)}
          title="Review and resolve sync conflicts"
          aria-label={`${status.openConflicts} open conflict${status.openConflicts === 1 ? '' : 's'} — review and resolve`}
          className="flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
        >
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
          {status.openConflicts} conflict{status.openConflicts === 1 ? '' : 's'}
        </button>
      )}

      {status.failedPushes > 0 && (
        <button
          onClick={() => setShowConflicts(true)}
          title="Failed pushes need review — open the conflicts drawer"
          aria-label={`${status.failedPushes} failed push${status.failedPushes === 1 ? '' : 'es'} — review in conflicts drawer`}
          className="flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
        >
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
          {status.failedPushes} failed
        </button>
      )}

      <button
        onClick={() => pull.mutate()}
        disabled={pull.isPending}
        aria-label="Pull latest changes from GitHub"
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
      >
        {pull.isPending ? (
          <Spinner size="sm" inline />
        ) : (
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        )}
        Pull now
      </button>

      <ConflictsDrawer
        open={showConflicts}
        onClose={() => setShowConflicts(false)}
        projectId={projectId}
        boardId={boardId}
      />
    </div>
  )
}
