import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FolderOpen, Plug, Plus, Trash2, Loader2, RefreshCw, CheckCircle2,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'
import { Badge, SOURCE_LABELS } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { Field } from '../../components/ui/Field'

type Tab = 'sources' | 'project'

// ── Types ────────────────────────────────────────────────────────────────────

type ConnectionSource = 'github' | 'jira' | 'confluence' | 'notion' | 'onedrive'

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
  syncError: string | null
  createdAt: string
}

// ── Source config ─────────────────────────────────────────────────────────────

interface ScopeField {
  key: string
  label: string
  required: boolean
  placeholder?: string
}

/** Per-project resource scope fields for each source. */
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
  const { currentProject, archiveProject } = useProjectStore()
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
      {tab === 'project' && <ProjectTab project={currentProject} onArchive={archiveProject} />}
    </div>
  )
}

// ── Sources Tab ───────────────────────────────────────────────────────────────

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
    },
    onError: (e: Error) => setListError(e.message),
  })

  async function handleSync(source: ProjectSource) {
    setSyncingSource(source.id)
    setListError(null)
    try {
      await api.post(`/projects/${projectId}/integrations/sync`, { source: source.source })
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncingSource(null)
      qc.invalidateQueries({ queryKey: ['sources', projectId] })
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
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
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
                source={source}
                connection={connections.find((c) => c.id === source.connectionId) ?? null}
                syncing={syncingSource === source.id}
                onSync={() => handleSync(source)}
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

function SourceCard({
  source, connection, syncing, onSync, onRemove, removePending,
}: {
  source: ProjectSource
  connection: Connection | null
  syncing: boolean
  onSync: () => void
  onRemove: () => void
  removePending: boolean
}) {
  const scope = scopeSummary(source.source, parseMetadata(source.metadata))

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
            </p>
            <p className="text-xs text-muted-foreground">
              via {connection ? connection.label : 'removed account'}
              {' · '}
              {source.lastSyncedAt
                ? `Last synced ${formatDate(source.lastSyncedAt)}`
                : 'Never synced'}
              {source.syncError && (
                <span className="ml-2 text-destructive">· {source.syncError}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onSync}
            disabled={syncing}
            title="Sync now"
            aria-label={`Sync ${source.label} now`}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {syncing
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            onClick={onRemove}
            disabled={removePending}
            title="Remove"
            aria-label={`Remove ${source.label}`}
            className="rounded p-1 text-destructive hover:bg-accent disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Add source form ───────────────────────────────────────────────────────────

function AddSourceForm({
  projectId, connections, onDone,
}: {
  projectId: string
  connections: Connection[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [label, setLabel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const connection = connections.find((c) => c.id === connectionId) ?? null
  const scopeFields = connection ? SCOPE_FIELDS[connection.source] : []

  const add = useMutation({
    mutationFn: (body: { source: ConnectionSource; connectionId: string; label: string; metadata: Record<string, string> }) =>
      api.post(`/projects/${projectId}/integrations`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources', projectId] })
      setValues({})
      setLabel('')
      setFormError(null)
      onDone()
    },
    onError: (e: Error) => setFormError(e.message),
  })

  function handleConnectionChange(nextId: string) {
    setConnectionId(nextId)
    setValues({})
    setFormError(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!connection) {
      setFormError('Pick a connected account.')
      return
    }
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

  return (
    <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-lg border border-border p-4">
      {/* Connection picker */}
      <Field id="source-connection" label="Connected account">
        <select
          id="source-connection"
          value={connectionId}
          onChange={(e) => handleConnectionChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({SOURCE_LABELS[c.source]})
            </option>
          ))}
        </select>
      </Field>

      {/* Scope fields for the chosen connection's source */}
      {scopeFields.map((field) => (
        <Field key={field.key} id={`source-${field.key}`} label={field.label}>
          <input
            id={`source-${field.key}`}
            type="text"
            placeholder={field.placeholder ?? field.label}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
          />
        </Field>
      ))}

      <Field id="source-label" label="Label">
        <input
          id="source-label"
          type="text"
          placeholder={`Optional, defaults to "${connection?.label ?? 'account label'}"`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
        />
      </Field>

      {formError && <p className="text-xs text-destructive">{formError}</p>}

      <button
        type="submit"
        disabled={add.isPending}
        className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Add source
      </button>
    </form>
  )
}

// ── Project Tab ───────────────────────────────────────────────────────────────

interface ProjectTabProps {
  project: { id: string; name: string; description: string | null; createdAt: string }
  onArchive: (id: string) => Promise<void>
}

function ProjectTab({ project, onArchive }: ProjectTabProps) {
  const [confirming, setConfirming] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  async function handleArchive() {
    setArchiving(true)
    setArchiveError(null)
    try {
      await onArchive(project.id)
      setConfirming(false)
    } catch (e) {
      setArchiveError(e instanceof Error ? e.message : 'Archive failed')
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Project info */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">Project info</h2>
        <div className="divide-y divide-border rounded-lg border border-border">
          <Row label="Name" value={project.name} />
          <Row label="Description" value={project.description ?? '—'} />
          <Row label="Created" value={formatDate(project.createdAt)} />
          <Row label="Project ID" value={project.id} mono />
        </div>
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

function Spinner() {
  return (
    <div className="flex h-32 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
