import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ExternalLink, Github, LayoutGrid, Search } from 'lucide-react'
import { api } from '../../lib/api'
import { Dialog } from '../../components/ui/Dialog'
import { Spinner } from '../../components/ui/Spinner'
import { QueryError } from '../../components/ui/QueryError'
import { toast } from '../../components/ui/Toast'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal connection shape consumed from GET /connections. */
interface Connection {
  id: string
  source: string
  label: string
}

/** GET /connections/:connectionId/remote-boards */
interface RemoteBoardOption {
  id: string
  label: string
  sublabel?: string
  url?: string
}

interface ImportRemoteBoardDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  /** Called with the new local board id after a successful import. */
  onImported?: (boardId: string) => void
}

// ── Dialog ────────────────────────────────────────────────────────────────────
// Step 1: pick a GitHub connection. Step 2: pick one of its remote Projects.
// Picking a project immediately creates the mirror (POST /mirrors).

export function ImportRemoteBoardDialog({
  open, onClose, projectId, onImported,
}: ImportRemoteBoardDialogProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  // Start each open at step 1 with a clean search.
  useEffect(() => {
    if (open) {
      setConnectionId(null)
      setSearch('')
    }
  }, [open])

  const {
    data: connections = [], isLoading: connsLoading,
    isError: connsError, error: connsErr, refetch: refetchConns,
  } = useQuery<Connection[]>({
    queryKey: ['connections'],
    queryFn: () => api.get('/connections'),
    enabled: open,
  })

  const githubConnections = connections.filter((c) => c.source === 'github')

  const {
    data: remoteBoards = [], isLoading: boardsLoading,
    isError: boardsError, error: boardsErr, refetch: refetchBoards,
  } = useQuery<RemoteBoardOption[]>({
    queryKey: ['remote-boards', connectionId],
    queryFn: () => api.get(`/connections/${connectionId}/remote-boards`),
    enabled: open && connectionId !== null,
    retry: false,
  })

  const importBoard = useMutation({
    mutationFn: (option: RemoteBoardOption) => {
      if (!connectionId) throw new Error('Pick a GitHub connection first.')
      return api.post<{ boardId: string }>(`/projects/${projectId}/mirrors`, {
        connectionId,
        remoteId: option.id,
        label: option.label,
      })
    },
    onSuccess: ({ boardId }) => {
      qc.invalidateQueries({ queryKey: ['boards', projectId] })
      toast.success('Board imported from GitHub')
      onImported?.(boardId)
      onClose()
    },
    onError: (e: Error) => toast.error(`Import failed: ${e.message}`),
  })

  const selectedConnection = githubConnections.find((c) => c.id === connectionId)
  const query = search.trim().toLowerCase()
  const filtered = query === ''
    ? remoteBoards
    : remoteBoards.filter((b) =>
        b.label.toLowerCase().includes(query) || (b.sublabel?.toLowerCase().includes(query) ?? false),
      )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import from GitHub"
      footer={
        <button
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Cancel
        </button>
      }
    >
      {connectionId === null ? (
        // ── Step 1: pick a GitHub connection ─────────────────────────────────
        connsLoading ? (
          <Spinner />
        ) : connsError ? (
          <QueryError message={connsErr instanceof Error ? connsErr.message : undefined} onRetry={() => refetchConns()} />
        ) : githubConnections.length === 0 ? (
          <div className="py-6 text-center">
            <Github className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No GitHub connection</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect a GitHub account first, then come back to import a Project board.
            </p>
            <button
              onClick={() => { onClose(); navigate('/connections') }}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Go to Connections
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Pick the GitHub connection to import from.</p>
            <ul className="space-y-1">
              {githubConnections.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setConnectionId(c.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <Github className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{c.label}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">GitHub</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : (
        // ── Step 2: pick a remote GitHub Project ─────────────────────────────
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConnectionId(null)}
              aria-label="Back to connection list"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {selectedConnection?.label ?? 'GitHub connection'}
            </span>
          </div>

          {boardsLoading ? (
            <Spinner />
          ) : boardsError ? (
            <QueryError message={boardsErr instanceof Error ? boardsErr.message : undefined} onRetry={() => refetchBoards()} />
          ) : remoteBoards.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No GitHub Projects found on this connection.
            </p>
          ) : (
            <>
              {remoteBoards.length > 5 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <input
                    autoFocus
                    aria-label="Search GitHub Projects"
                    placeholder="Search projects…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              )}
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No projects match &ldquo;{search.trim()}&rdquo;.
                </p>
              ) : (
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {filtered.map((b) => (
                    <li key={b.id}>
                      <div className="flex items-center gap-1.5 rounded-lg border border-border transition-colors hover:border-primary/40 hover:bg-accent">
                        <button
                          onClick={() => importBoard.mutate(b)}
                          disabled={importBoard.isPending}
                          aria-label={`Import ${b.label} as a mirrored board`}
                          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{b.label}</span>
                            {b.sublabel && (
                              <span className="block truncate text-[11px] text-muted-foreground">{b.sublabel}</span>
                            )}
                          </span>
                          {importBoard.isPending && importBoard.variables?.id === b.id && (
                            <Spinner size="sm" inline />
                          )}
                        </button>
                        {b.url && (
                          <a
                            href={b.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Open ${b.label} on GitHub`}
                            className="mr-2 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
