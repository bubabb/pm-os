import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, ChevronDown, ExternalLink, FolderOpen, Pencil, Plug, Plus,
  Trash2, Loader2, RefreshCw, CheckCircle2, Search, X,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'
import { Badge, SOURCE_LABELS } from '../../components/ui/Badge'
import type { BadgeVariant } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { Field } from '../../components/ui/Field'
import { Spinner } from '../../components/ui/Spinner'
import { toast } from '../../components/ui/Toast'

type Tab = 'sources' | 'project'

// ── Types ────────────────────────────────────────────────────────────────────

type ConnectionSource = 'github' | 'jira' | 'confluence' | 'notion' | 'onedrive'

type SyncStatus = 'idle' | 'syncing' | 'error'

interface Connection {
  id: string
  source: ConnectionSource
  label: string
  /** Stringified JSON from the API. */
  metadata: string
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

interface ProjectSource {
  id: string
  projectId: string
  source: ConnectionSource
  connectionId: string
  label: string
  /** Stringified JSON from the API. */
  metadata: string
  lastSyncedAt: string | null
  syncStatus: SyncStatus
  syncError: string | null
  createdAt: string
}

/** A pickable per-project resource from `GET /connections/:id/resources`. */
interface ResourceOption {
  id: string
  label: string
  sublabel?: string
  /** Exact per-project scope to persist (e.g. github → { owner, repo }). */
  metadata: Record<string, string>
}

/** One entry from `GET /projects/:id/integrations/status`. */
interface SyncStatusEntry {
  credentialId: string
  source: ConnectionSource
  status: SyncStatus
  lastSyncedAt: string | null
  lastErrorMessage: string | null
}

/** One normalized item from `GET /projects/:id/integrations/events?source=…`. */
interface SyncedEvent {
  entityType: string
  entityId: string
  title: string
  status: string
  entityUrl: string
  updatedAt: string
}

/** Request/response shapes for `POST /projects/:id/integrations/bulk`. */
interface BulkItem {
  source: ConnectionSource
  connectionId: string
  label: string
  metadata: Record<string, string>
}

interface BulkResult {
  created: ProjectSource[]
  failed: Array<{ label: string; error: string }>
}

// ── Source config ─────────────────────────────────────────────────────────────

interface ScopeField {
  key: string
  label: string
  required: boolean
  placeholder?: string
}

/** Per-project resource scope fields for each source (manual-entry fallback). */
const SCOPE_FIELDS: Record<ConnectionSource, ScopeField[]> = {
  github: [
    { key: 'owner', label: 'Owner', required: true, placeholder: 'Owner (e.g. my-org)' },
    { key: 'repo',  label: 'Repo',  required: true, placeholder: 'Repo (e.g. my-repo)' },
  ],
  jira: [
    { key: 'projectKey', label: 'Project key', required: true, placeholder: 'Project key (e.g. PROJ)' },
  ],
  confluence: [
    { key: 'spaceId', label: 'Space ID', required: true, placeholder: 'Numeric space ID (not the space key)' },
  ],
  notion: [
    { key: 'databaseId', label: 'Database ID', required: true, placeholder: 'Database ID' },
  ],
  onedrive: [
    { key: 'folder', label: 'Folder', required: false, placeholder: 'Folder (optional)' },
  ],
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function scopeSummary(source: ConnectionSource, metadata: Record<string, string>): string | null {
  switch (source) {
    case 'github':
      return metadata.owner && metadata.repo ? `${metadata.owner}/${metadata.repo}` : metadata.owner ?? metadata.repo ?? null
    case 'jira':
      return metadata.projectKey ?? null
    case 'confluence':
      return metadata.spaceId ?? null
    case 'notion':
      return metadata.databaseId ?? null
    case 'onedrive':
      return metadata.folder ?? null
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Settings() {
  const { currentProject, archiveProject, renameProject } = useProjectStore()
  const [tab, setTab] = useState<Tab>('sources')

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view settings.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-xl font-semibold text-foreground">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Project: <span className="font-medium text-foreground">{currentProject.name}</span>
      </p>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b border-border">
        {([
          { id: 'sources' as Tab, label: 'Sources', icon: Plug },
          { id: 'project' as Tab, label: 'Project', icon: FolderOpen },
        ]).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === id
                ? 'border-primary text-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'sources' && <SourcesTab projectId={currentProject.id} />}
      {tab === 'project' && (
        <ProjectTab
          project={currentProject}
          onArchive={archiveProject}
          onRename={renameProject}
        />
      )}
    </div>
  )
}

// ── Sources Tab ───────────────────────────────────────────────────────────────

const SYNC_POLL_INTERVAL_MS = 1500
const SYNC_POLL_TIMEOUT_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function SourcesTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [syncingSource, setSyncingSource] = useState<string | null>(null)

  const {
    data: connections = [], isLoading: connectionsLoading,
    isError: connectionsError, error: connectionsErr, refetch: refetchConnections,
  } = useQuery<Connection[]>({
    queryKey: ['connections'],
    queryFn: () => api.get('/connections'),
  })

  const {
    data: sources = [], isLoading: sourcesLoading,
    isError: sourcesError, error: sourcesErr, refetch: refetchSources,
  } = useQuery<ProjectSource[]>({
    queryKey: ['sources', projectId],
    queryFn: () => api.get(`/projects/${projectId}/integrations`),
  })

  const remove = useMutation({
    mutationFn: (credentialId: string) =>
      api.delete(`/projects/${projectId}/integrations/${credentialId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', projectId] })
      setListError(null)
      toast.success('Source removed')
    },
    onError: (e: Error) => {
      setListError(e.message)
      toast.error(e.message)
    },
  })

  /**
   * Kick a sync, then poll the status endpoint until the matching source
   * leaves 'syncing' (or its lastSyncedAt advances), then report the outcome.
   */
  async function handleSync(source: ProjectSource) {
    setSyncingSource(source.id)
    setListError(null)
    const prevSyncedAt = source.lastSyncedAt
    try {
      await api.post(`/projects/${projectId}/integrations/sync`, { source: source.source })

      const deadline = Date.now() + SYNC_POLL_TIMEOUT_MS
      let final: SyncStatusEntry | null = null
      while (Date.now() < deadline) {
        await sleep(SYNC_POLL_INTERVAL_MS)
        const statuses = await api.get<SyncStatusEntry[]>(
          `/projects/${projectId}/integrations/status`,
        )
        const entry =
          statuses.find((s) => s.credentialId === source.id) ??
          statuses.find((s) => s.source === source.source) ??
          null
        if (
          entry &&
          entry.status !== 'syncing' &&
          (entry.status === 'error' || entry.lastSyncedAt !== prevSyncedAt)
        ) {
          final = entry
          break
        }
      }

      if (!final) {
        toast.info('Sync is taking longer than expected — it will finish in the background.')
      } else if (final.status === 'error') {
        toast.error(final.lastErrorMessage ?? 'Sync failed')
      } else {
        // Fetch the synced items so we can report a count (and warm the cache
        // behind the "View synced items" panel).
        let count: number | null = null
        try {
          const items = await api.get<SyncedEvent[]>(
            `/projects/${projectId}/integrations/events?source=${encodeURIComponent(source.source)}`,
          )
          qc.setQueryData(['source-events', projectId, source.source], items)
          count = items.length
        } catch {
          // Count is cosmetic — the sync itself succeeded.
        }
        toast.success(count !== null ? `Synced — ${count} item${count === 1 ? '' : 's'}` : 'Synced')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Sync failed'
      setListError(msg)
      toast.error(msg)
    } finally {
      setSyncingSource(null)
      void qc.invalidateQueries({ queryKey: ['sources', projectId] })
    }
  }

  if (connectionsLoading || sourcesLoading) return <Spinner />

  if (connectionsError || sourcesError) {
    const err = connectionsError ? connectionsErr : sourcesErr
    return (
      <QueryError
        message={err instanceof Error ? err.message : undefined}
        onRetry={() => { void refetchConnections(); void refetchSources() }}
      />
    )
  }

  if (connections.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">
          No connected accounts yet. Add a GitHub, Jira, Confluence, Notion, or OneDrive
          account on the{' '}
          <NavLink to="/connections" className="font-medium text-primary hover:underline">
            Connections page
          </NavLink>{' '}
          first, then come back here to bind it to this project.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Sources</h2>
          </div>
          <button
            onClick={() => setFormOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {formOpen ? 'Cancel' : 'Add source'}
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Bind a connected account to this project with a resource scope (repo, project key,
          space, database) to start pulling data in.
        </p>

        {formOpen && (
          <AddSourceForm
            projectId={projectId}
            connections={connections}
            sources={sources}
            onDone={() => setFormOpen(false)}
          />
        )}

        {sources.length === 0 ? (
          !formOpen && (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No sources yet. Click &ldquo;Add source&rdquo; to bind a connected account to
                this project.
              </p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <SourceCard
                key={source.id}
                projectId={projectId}
                source={source}
                connection={connections.find((c) => c.id === source.connectionId) ?? null}
                syncing={syncingSource === source.id}
                onSync={() => void handleSync(source)}
                onRemove={() => remove.mutate(source.id)}
                removePending={remove.isPending}
              />
            ))}
          </div>
        )}

        {listError && <p className="mt-2 text-xs text-destructive">{listError}</p>}
      </section>
    </div>
  )
}

// ── Source card ───────────────────────────────────────────────────────────────

/** Heuristic mapping of normalized item statuses to badge colors. */
function statusVariant(status: string | null | undefined): BadgeVariant {
  const s = (status ?? '').toLowerCase().replace(/[_-]/g, ' ')
  if (['closed', 'done', 'merged', 'resolved', 'completed'].includes(s)) return 'success'
  if (['open', 'in progress', 'todo', 'to do', 'in review'].includes(s)) return 'info'
  if (['blocked', 'failed', 'error'].includes(s)) return 'danger'
  return 'neutral'
}

function SourceCard({
  projectId, source, connection, syncing, onSync, onRemove, removePending,
}: {
  projectId: string
  source: ProjectSource
  connection: Connection | null
  syncing: boolean
  onSync: () => void
  onRemove: () => void
  removePending: boolean
}) {
  const scope = scopeSummary(source.source, parseMetadata(source.metadata))
  const [showItems, setShowItems] = useState(false)
  const panelId = `synced-items-${source.id}`

  // Server-reported in-flight sync (e.g. started elsewhere) or our own poll loop.
  const isSyncing = syncing || source.syncStatus === 'syncing'

  const {
    data: events,
    isLoading: eventsLoading,
    isError: eventsError,
    error: eventsErr,
    refetch: refetchEvents,
  } = useQuery<SyncedEvent[]>({
    queryKey: ['source-events', projectId, source.source],
    queryFn: () =>
      api.get(`/projects/${projectId}/integrations/events?source=${encodeURIComponent(source.source)}`),
    enabled: showItems,
  })

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge source={source.source}>{SOURCE_LABELS[source.source]}</Badge>
          <div>
            <p className="flex items-center gap-1.5 text-sm text-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {source.label}
              {scope && (
                <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {scope}
                </span>
              )}
              {isSyncing && (
                <Badge variant="info">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Syncing…
                </Badge>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              via {connection ? connection.label : 'removed account'}
              {' · '}
              {source.lastSyncedAt
                ? `Last synced ${formatRelative(source.lastSyncedAt)}`
                : 'Never synced'}
            </p>
            {source.syncStatus === 'error' && source.syncError && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                {source.syncError}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onSync}
            disabled={isSyncing}
            title="Sync now"
            aria-label={`Sync ${source.label} now`}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40"
          >
            {isSyncing
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            onClick={onRemove}
            disabled={removePending}
            title="Remove"
            aria-label={`Remove ${source.label}`}
            className="rounded p-1 text-destructive hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Browsable synced items */}
      <button
        type="button"
        onClick={() => setShowItems((s) => !s)}
        aria-expanded={showItems}
        aria-controls={panelId}
        className="mt-3 flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${showItems ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
        View synced items
      </button>

      {showItems && (
        <div id={panelId} className="mt-2 border-t border-border pt-2">
          {eventsLoading ? (
            <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Spinner inline size="sm" />
              Loading synced items…
            </p>
          ) : eventsError ? (
            <p className="py-2 text-xs text-destructive">
              Couldn&rsquo;t load synced items
              {eventsErr instanceof Error ? `: ${eventsErr.message}` : ''}.{' '}
              <button
                type="button"
                onClick={() => void refetchEvents()}
                className="rounded font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary"
              >
                Retry
              </button>
            </p>
          ) : (events ?? []).length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">No open items synced yet.</p>
          ) : (
            <ul
              aria-label={`Synced items from ${source.label}`}
              className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border"
            >
              {(events ?? []).map((item) => (
                <li
                  key={`${item.entityType}:${item.entityId}`}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.entityType} · updated {formatRelative(item.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                    {item.entityUrl && (
                      <a
                        href={item.entityUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${item.title} in browser`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ── Add source form ───────────────────────────────────────────────────────────

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary'

function AddSourceForm({
  projectId, connections, sources, onDone,
}: {
  projectId: string
  connections: Connection[]
  /** Sources already bound to this project — used to dedupe picker rows. */
  sources: ProjectSource[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [label, setLabel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [manualOverride, setManualOverride] = useState(false)
  const [picked, setPicked] = useState<Map<string, ResourceOption>>(new Map())
  const [filter, setFilter] = useState('')

  const connection = connections.find((c) => c.id === connectionId) ?? null
  const scopeFields = connection ? SCOPE_FIELDS[connection.source] : []

  const {
    data: resources,
    isLoading: resourcesLoading,
    isError: resourcesError,
    error: resourcesErr,
    refetch: refetchResources,
  } = useQuery<ResourceOption[]>({
    queryKey: ['connection-resources', connectionId],
    queryFn: () => api.get(`/connections/${connectionId}/resources`),
    enabled: connectionId !== '',
    retry: false,
  })

  /** Picker has usable options. */
  const pickerAvailable = !resourcesLoading && !resourcesError && (resources?.length ?? 0) > 0
  /** Upstream failed (502) or returned nothing — fall back to manual entry. */
  const pickerUnavailable = !resourcesLoading && (resourcesError || (resources?.length ?? 0) === 0)
  const manualMode = manualOverride || pickerUnavailable

  const query = filter.trim().toLowerCase()
  const filteredResources = (resources ?? []).filter((r) =>
    query === '' ||
    r.label.toLowerCase().includes(query) ||
    (r.sublabel?.toLowerCase().includes(query) ?? false),
  )

  // Scopes already bound to this project (same source) — disable those rows.
  const boundScopes = new Set(
    sources
      .map((s) => {
        const summary = scopeSummary(s.source, parseMetadata(s.metadata))
        return summary ? `${s.source}:${summary}` : null
      })
      .filter((k): k is string => k !== null),
  )
  function isAlreadyBound(r: ResourceOption): boolean {
    if (!connection) return false
    const summary = scopeSummary(connection.source, r.metadata)
    return summary !== null && boundScopes.has(`${connection.source}:${summary}`)
  }

  function resetForm() {
    setValues({})
    setLabel('')
    setPicked(new Map())
    setFilter('')
    setManualOverride(false)
    setFormError(null)
  }

  const add = useMutation({
    mutationFn: (body: { source: ConnectionSource; connectionId: string; label: string; metadata: Record<string, string> }) =>
      api.post(`/projects/${projectId}/integrations`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sources', projectId] })
      resetForm()
      toast.success('Source added')
      onDone()
    },
    onError: (e: Error) => {
      setFormError(e.message)
      toast.error(e.message)
    },
  })

  const bulkAdd = useMutation<BulkResult, Error, { items: BulkItem[] }>({
    mutationFn: (body) => api.post(`/projects/${projectId}/integrations/bulk`, body),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sources', projectId] })
      if (res.failed.length === 0) {
        toast.success(`Added ${res.created.length} source${res.created.length === 1 ? '' : 's'}`)
        resetForm()
        onDone()
        return
      }
      // Partial (or total) failure: keep the failed picks selected for retry.
      const failedLabels = new Set(res.failed.map((f) => f.label))
      setPicked((prev) => new Map([...prev].filter(([, r]) => failedLabels.has(r.label))))
      const detail = res.failed.map((f) => `${f.label}: ${f.error}`).join('; ')
      const msg = res.created.length > 0
        ? `Added ${res.created.length}, failed ${res.failed.length}: ${detail}`
        : `Failed to add ${res.failed.length} source${res.failed.length === 1 ? '' : 's'}: ${detail}`
      toast.error(msg)
      setFormError(msg)
    },
    onError: (e: Error) => {
      setFormError(e.message)
      toast.error(e.message)
    },
  })

  const submitting = add.isPending || bulkAdd.isPending

  function handleConnectionChange(nextId: string) {
    setConnectionId(nextId)
    setValues({})
    setPicked(new Map())
    setFilter('')
    setManualOverride(false)
    setFormError(null)
  }

  function togglePicked(r: ResourceOption) {
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(r.id)) next.delete(r.id)
      else next.set(r.id, r)
      return next
    })
    setFormError(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!connection) {
      setFormError('Pick a connected account.')
      return
    }

    if (!manualMode) {
      if (picked.size === 0) {
        setFormError('Pick at least one resource from the list, or enter it manually.')
        return
      }
      if (picked.size > 1) {
        const items: BulkItem[] = [...picked.values()].map((r) => ({
          source: connection.source,
          connectionId: connection.id,
          label: r.label,
          metadata: r.metadata,
        }))
        bulkAdd.mutate({ items })
        return
      }
      const single = picked.values().next().value
      if (!single) return
      add.mutate({
        source: connection.source,
        connectionId: connection.id,
        label: label.trim() || single.label,
        metadata: single.metadata,
      })
      return
    }

    // Manual entry (always single).
    const missing = scopeFields.filter((f) => f.required && !(values[f.key] ?? '').trim())
    if (missing.length > 0) {
      setFormError(`${missing.map((f) => f.label).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required.`)
      return
    }
    const metadata: Record<string, string> = {}
    for (const field of scopeFields) {
      const v = (values[field.key] ?? '').trim()
      if (v) metadata[field.key] = v
    }
    add.mutate({
      source: connection.source,
      connectionId: connection.id,
      label: label.trim() || connection.label,
      metadata,
    })
  }

  const singlePicked = picked.size === 1
    ? picked.values().next().value ?? null
    : null
  const pickedScope = connection && singlePicked
    ? scopeSummary(connection.source, singlePicked.metadata) ?? singlePicked.label
    : null
  const multiPick = !manualMode && picked.size > 1

  return (
    <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-lg border border-border p-4">
      {/* Connection picker */}
      <Field id="source-connection" label="Connected account">
        <select
          id="source-connection"
          value={connectionId}
          onChange={(e) => handleConnectionChange(e.target.value)}
          className={INPUT_CLASS}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({SOURCE_LABELS[c.source]})
            </option>
          ))}
        </select>
      </Field>

      {/* Resource scope: provider-backed multi-select picker with manual fallback */}
      {connection && (
        resourcesLoading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner inline size="sm" />
            Loading available resources…
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {manualMode
                  ? 'Resource scope (manual entry)'
                  : `Pick ${SOURCE_LABELS[connection.source]} resources (click to toggle)`}
              </span>
              {pickerAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    // Manual entry is single — drop the multi-selection going in.
                    if (!manualOverride) setPicked(new Map())
                    setManualOverride(!manualOverride)
                    setFormError(null)
                  }}
                  className="rounded text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  {manualMode ? 'Choose from list' : 'Enter manually'}
                </button>
              )}
            </div>

            {pickerUnavailable && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs">
                <p className="flex items-start gap-1.5 text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {resourcesError ? (
                    <span>
                      Couldn&rsquo;t load from {SOURCE_LABELS[connection.source]}:{' '}
                      <span className="break-all font-mono text-amber-200">
                        {resourcesErr instanceof Error ? resourcesErr.message : 'request failed'}
                      </span>
                      . If this is an auth error, fix the token on the{' '}
                      <NavLink to="/connections" className="font-medium text-primary hover:underline">
                        Connections
                      </NavLink>{' '}
                      page, or enter the scope manually below.
                    </span>
                  ) : (
                    <span>No resources found for this account — enter the scope manually below.</span>
                  )}
                </p>
                {resourcesError && (
                  <button
                    type="button"
                    onClick={() => void refetchResources()}
                    className="mt-1.5 rounded text-xs font-medium text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}

            {manualMode ? (
              scopeFields.map((field) => (
                <Field key={field.key} id={`source-${field.key}`} label={field.label}>
                  <input
                    id={`source-${field.key}`}
                    type="text"
                    placeholder={field.placeholder ?? field.label}
                    value={values[field.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    className={INPUT_CLASS}
                  />
                </Field>
              ))
            ) : (
              <>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    aria-label="Filter resources"
                    placeholder="Filter resources…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className={`${INPUT_CLASS} pl-8`}
                  />
                </div>
                <ul
                  role="listbox"
                  aria-label="Available resources"
                  aria-multiselectable="true"
                  className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border"
                >
                  {filteredResources.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      No resources match &ldquo;{filter}&rdquo;.
                    </li>
                  ) : (
                    filteredResources.map((r) => {
                      const bound = isAlreadyBound(r)
                      const selected = picked.has(r.id)
                      return (
                        <li key={r.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            disabled={bound}
                            onClick={() => togglePicked(r)}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary ${
                              bound
                                ? 'cursor-not-allowed opacity-50'
                                : selected
                                  ? 'bg-accent text-foreground'
                                  : 'text-foreground hover:bg-accent/50'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate">{r.label}</span>
                              {r.sublabel && (
                                <span className="block truncate text-xs text-muted-foreground">{r.sublabel}</span>
                              )}
                            </span>
                            {bound ? (
                              <Badge variant="neutral">Added</Badge>
                            ) : selected ? (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                            ) : null}
                          </button>
                        </li>
                      )
                    })
                  )}
                </ul>

                {/* Selection summary: count + removable chips */}
                {picked.size > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{picked.size} selected</span>
                    {[...picked.values()].map((r) => (
                      <span
                        key={r.id}
                        className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs text-foreground"
                      >
                        {r.label}
                        <button
                          type="button"
                          onClick={() => togglePicked(r)}
                          aria-label={`Deselect ${r.label}`}
                          className="rounded text-muted-foreground hover:text-destructive focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {pickedScope && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Scope:
                    <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {pickedScope}
                    </span>
                  </p>
                )}
              </>
            )}
          </div>
        )
      )}

      <Field
        id="source-label"
        label="Label"
        {...(multiPick ? { hint: 'Each source gets its resource name as the label when adding multiple.' } : {})}
      >
        <input
          id="source-label"
          type="text"
          disabled={multiPick}
          placeholder={
            multiPick
              ? 'Labels come from each resource'
              : `Optional, defaults to "${(!manualMode && singlePicked ? singlePicked.label : connection?.label) ?? 'account label'}"`
          }
          value={multiPick ? '' : label}
          onChange={(e) => setLabel(e.target.value)}
          className={`${INPUT_CLASS} disabled:opacity-50`}
        />
      </Field>

      {formError && <p className="text-xs text-destructive">{formError}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {multiPick ? `Add ${picked.size} sources` : 'Add source'}
      </button>
    </form>
  )
}

// ── Project Tab ───────────────────────────────────────────────────────────────

interface ProjectTabProps {
  project: { id: string; name: string; description: string | null; createdAt: string }
  onArchive: (id: string) => Promise<void>
  onRename: (id: string, patch: { name?: string; description?: string }) => Promise<unknown>
}

function ProjectTab({ project, onArchive, onRename }: ProjectTabProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [confirming, setConfirming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  function startEditing() {
    setName(project.name)
    setDescription(project.description ?? '')
    setEditError(null)
    setEditing(true)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setEditError('Name is required.')
      return
    }
    setSaving(true)
    setEditError(null)
    try {
      await onRename(project.id, { name: trimmedName, description: description.trim() })
      toast.success('Project updated')
      setEditing(false)
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : 'Update failed'
      setEditError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  async function handleArchive() {
    setArchiving(true)
    setArchiveError(null)
    try {
      await onArchive(project.id)
      setConfirming(false)
      toast.success('Project archived')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Archive failed'
      setArchiveError(msg)
      toast.error(msg)
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Project info */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-foreground">Project info</h2>
          {!editing && (
            <button
              onClick={startEditing}
              aria-label="Edit project name and description"
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <form
            onSubmit={handleSave}
            className="space-y-3 rounded-lg border border-border p-4"
          >
            <Field id="project-name" label="Name">
              <input
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
                className={INPUT_CLASS}
              />
            </Field>
            <Field id="project-description" label="Description">
              <textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project about? (optional)"
                rows={3}
                className={`${INPUT_CLASS} resize-y`}
              />
            </Field>

            {editError && <p className="text-xs text-destructive">{editError}</p>}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save changes
              </button>
              <button
                type="button"
                onClick={() => { setEditing(false); setEditError(null) }}
                disabled={saving}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            <Row label="Name" value={project.name} />
            <Row label="Description" value={project.description ?? '—'} />
            <Row label="Created" value={formatDate(project.createdAt)} />
            <Row label="Project ID" value={project.id} mono />
          </div>
        )}
      </section>

      {/* Danger zone */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-destructive">Danger zone</h2>
        <div className="rounded-lg border border-destructive/40 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Archive this project</p>
              <p className="text-xs text-muted-foreground">
                The project will be hidden from the project list. Data is preserved.
              </p>
            </div>
            {confirming ? (
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
                >
                  Cancel
                </button>
                <button
                  onClick={handleArchive}
                  disabled={archiving}
                  className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {archiving && <Loader2 className="h-3 w-3 animate-spin" />}
                  Confirm archive
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="rounded-md border border-destructive/60 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                Archive
              </button>
            )}
          </div>
          {archiveError && <p className="mt-2 text-xs text-destructive">{archiveError}</p>}
        </div>
      </section>
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center px-4 py-3">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`text-sm text-foreground ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Compact relative timestamp for sync metadata ("just now", "2m ago", …). */
function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs < 60_000) return 'just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}
