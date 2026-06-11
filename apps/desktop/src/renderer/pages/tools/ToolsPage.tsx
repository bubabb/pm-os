import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Package, Plus, Loader2, Rocket, Undo2, CheckCircle2, Tag, History,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'
import { Badge, type BadgeVariant } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { toast } from '../../components/ui/Toast'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Tool {
  id: string
  projectId: string
  name: string
  description: string | null
  createdById: string
  latestVersionId: string | null
  createdAt: string
  updatedAt: string
}

interface ToolVersion {
  id: string
  toolId: string
  version: string
  schema: string
  implementation: string
  changelog: string | null
  publishedById: string
  publishedAt: string
  createdAt: string
}

type DeploymentStatus = 'deploying' | 'active' | 'rolled_back' | 'superseded' | 'failed'

interface ToolDeployment {
  id: string
  toolId: string
  toolVersionId: string
  projectId: string
  status: DeploymentStatus
  deployedById: string
  previousVersionId: string | null
  createdAt: string
  updatedAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEPLOYMENT_STATUS_BADGE: Record<DeploymentStatus, { label: string; variant: BadgeVariant }> = {
  deploying:   { label: 'Deploying',   variant: 'info' },
  active:      { label: 'Active',      variant: 'success' },
  rolled_back: { label: 'Rolled back', variant: 'warning' },
  superseded:  { label: 'Superseded',  variant: 'neutral' },
  failed:      { label: 'Failed',      variant: 'danger' },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ToolsPage() {
  const { currentProject } = useProjectStore()

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view the tool registry.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground">Tool Registry</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Versioned AI tool artifacts for {currentProject.name}
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <Registry projectId={currentProject.id} />
      </div>
    </div>
  )
}

// ── Registry (master-detail) ────────────────────────────────────────────────────

function Registry({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')

  const { data: tools = [], isLoading, isError, error, refetch } = useQuery<Tool[]>({
    queryKey: ['tools', projectId],
    queryFn: () => api.get(`/projects/${projectId}/tools`),
  })

  const createTool = useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api.post<Tool>(`/projects/${projectId}/tools`, body),
    onSuccess: (tool) => {
      qc.invalidateQueries({ queryKey: ['tools', projectId] })
      setSelectedToolId(tool.id)
      setShowCreate(false)
      setNewName('')
      setNewDescription('')
    },
    onError: (e: Error) => toast.error(`Failed to create tool: ${e.message}`),
  })

  const activeToolId = selectedToolId ?? tools[0]?.id ?? null

  if (isLoading) return <Spinner />
  if (isError) {
    return (
      <div className="p-6">
        <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Tool list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium text-foreground">Tools</span>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>

        {showCreate && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!newName.trim()) return
              const body: { name: string; description?: string } = { name: newName.trim() }
              if (newDescription.trim()) body.description = newDescription.trim()
              createTool.mutate(body)
            }}
            className="space-y-2 border-b border-border bg-muted/30 p-3"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tool name"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
            />
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Description (optional)"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
            />
            <button
              type="submit"
              disabled={createTool.isPending || !newName.trim()}
              className="w-full rounded-md bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createTool.isPending ? 'Creating…' : 'Create tool'}
            </button>
          </form>
        )}

        <div className="flex-1 overflow-auto">
          {tools.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">No tools yet.</p>
          ) : (
            tools.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedToolId(t.id)}
                className={`flex w-full items-center gap-2 border-b border-border/60 px-4 py-2.5 text-left text-sm transition-colors ${
                  activeToolId === t.id ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted/50'
                }`}
              >
                <Package className="h-4 w-4 shrink-0 opacity-70" />
                <span className="truncate">{t.name}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail */}
      <div className="flex-1 overflow-auto p-6">
        {activeToolId
          ? <ToolDetail projectId={projectId} toolId={activeToolId} />
          : <p className="text-sm text-muted-foreground">Create a tool to get started.</p>}
      </div>
    </div>
  )
}

// ── Tool detail ─────────────────────────────────────────────────────────────────

function ToolDetail({ projectId, toolId }: { projectId: string; toolId: string }) {
  const qc = useQueryClient()
  const [showPublish, setShowPublish] = useState(false)

  const base = `/projects/${projectId}/tools/${toolId}`

  const {
    data: versions = [],
    isLoading: versionsLoading,
    isError: versionsError,
    error: versionsErrorObj,
    refetch: refetchVersions,
  } = useQuery<ToolVersion[]>({
    queryKey: ['tool-versions', toolId],
    queryFn: () => api.get(`${base}/versions`),
  })

  const {
    data: active = null,
    isError: activeError,
    error: activeErrorObj,
    refetch: refetchActive,
  } = useQuery<ToolDeployment | null>({
    queryKey: ['tool-active-deployment', toolId],
    queryFn: () => api.get<{ deployment: ToolDeployment | null }>(`${base}/deployments/active`).then((r) => r.deployment),
  })

  const {
    data: deployments = [],
    isError: deploymentsError,
    error: deploymentsErrorObj,
    refetch: refetchDeployments,
  } = useQuery<ToolDeployment[]>({
    queryKey: ['tool-deployments', toolId],
    queryFn: () => api.get(`${base}/deployments`),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['tool-versions', toolId] })
    qc.invalidateQueries({ queryKey: ['tool-active-deployment', toolId] })
    qc.invalidateQueries({ queryKey: ['tool-deployments', toolId] })
    qc.invalidateQueries({ queryKey: ['tools', projectId] })
  }

  const deploy = useMutation({
    mutationFn: (versionId: string) => api.post<ToolDeployment>(`${base}/deploy`, { versionId }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Deploy failed: ${e.message}`),
  })

  const rollback = useMutation({
    mutationFn: () => api.post<ToolDeployment>(`${base}/rollback`, {}),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Rollback failed: ${e.message}`),
  })

  const activeVersionId = active?.toolVersionId ?? null
  const canRollback = active != null && active.previousVersionId != null

  return (
    <div className="space-y-6">
      {/* Active deployment banner + rollback */}
      {activeError ? (
        <QueryError
          message={activeErrorObj instanceof Error ? activeErrorObj.message : undefined}
          onRetry={() => refetchActive()}
        />
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <Rocket className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            {active
              ? <span className="text-foreground">Active version: <span className="font-medium">{versionLabel(versions, active.toolVersionId)}</span></span>
              : <span className="text-muted-foreground">No version deployed yet.</span>}
          </div>
          <button
            onClick={() => rollback.mutate()}
            disabled={!canRollback || rollback.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/40 disabled:opacity-40"
            title={canRollback ? 'Roll back to previous version' : 'Nothing to roll back to'}
          >
            <Undo2 className="h-3.5 w-3.5" /> {rollback.isPending ? 'Rolling back…' : 'Rollback'}
          </button>
        </div>
      )}

      {/* Versions */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Tag className="h-4 w-4 opacity-70" /> Versions
          </h2>
          <button
            onClick={() => setShowPublish((v) => !v)}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" /> Publish version
          </button>
        </div>

        {showPublish && (
          <PublishVersionForm
            projectId={projectId}
            toolId={toolId}
            onDone={() => { setShowPublish(false); invalidate() }}
          />
        )}

        {versionsLoading ? <Spinner /> : versionsError ? (
          <QueryError
            message={versionsErrorObj instanceof Error ? versionsErrorObj.message : undefined}
            onRetry={() => refetchVersions()}
          />
        ) : versions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            No versions published yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {versions.map((v) => {
              const isActive = v.id === activeVersionId
              return (
                <li
                  key={v.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-foreground">v{v.version}</span>
                      {isActive && (
                        <Badge variant="success" className="rounded-full">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Active
                        </Badge>
                      )}
                    </div>
                    {v.changelog && <p className="mt-0.5 truncate text-xs text-muted-foreground">{v.changelog}</p>}
                  </div>
                  <button
                    onClick={() => deploy.mutate(v.id)}
                    disabled={isActive || deploy.isPending}
                    className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:border-primary/40 disabled:opacity-40"
                  >
                    <Rocket className="h-3.5 w-3.5" /> {isActive ? 'Deployed' : 'Deploy'}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Deployment history */}
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <History className="h-4 w-4 opacity-70" /> Deployment history
        </h2>
        {deploymentsError ? (
          <QueryError
            message={deploymentsErrorObj instanceof Error ? deploymentsErrorObj.message : undefined}
            onRetry={() => refetchDeployments()}
          />
        ) : deployments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No deployments yet.</p>
        ) : (
          <ul className="space-y-1">
            {deployments.map((d) => {
              const badge = DEPLOYMENT_STATUS_BADGE[d.status]
              return (
                <li key={d.id} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-xs">
                  <span className="font-mono text-foreground">v{versionLabel(versions, d.toolVersionId)}</span>
                  <div className="flex items-center gap-3">
                    <Badge variant={badge.variant} className="rounded-full">{badge.label}</Badge>
                    <span className="text-muted-foreground">{new Date(d.createdAt).toLocaleString()}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── Publish version form ────────────────────────────────────────────────────────

function PublishVersionForm({ projectId, toolId, onDone }: { projectId: string; toolId: string; onDone: () => void }) {
  const [version, setVersion] = useState('')
  const [schema, setSchema] = useState('{}')
  const [implementation, setImplementation] = useState('{}')
  const [changelog, setChangelog] = useState('')
  const [error, setError] = useState<string | null>(null)

  const publish = useMutation({
    mutationFn: (body: { version: string; schema: string; implementation: string; changelog?: string }) =>
      api.post<ToolVersion>(`/projects/${projectId}/tools/${toolId}/versions`, body),
    onSuccess: onDone,
    onError: (err: Error) => setError(err.message),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!version.trim()) { setError('Version is required'); return }
    // Validate JSON inputs before sending.
    try { JSON.parse(schema) } catch { setError('Schema must be valid JSON'); return }
    try { JSON.parse(implementation) } catch { setError('Implementation must be valid JSON'); return }
    const body: { version: string; schema: string; implementation: string; changelog?: string } = {
      version: version.trim(),
      schema,
      implementation,
    }
    if (changelog.trim()) body.changelog = changelog.trim()
    publish.mutate(body)
  }

  return (
    <form onSubmit={submit} className="mb-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <input
        autoFocus
        value={version}
        onChange={(e) => setVersion(e.target.value)}
        placeholder="Version (semver, e.g. 1.0.0)"
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
      <div className="grid grid-cols-2 gap-2">
        <textarea
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
          placeholder="Schema (JSON)"
          rows={4}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
        />
        <textarea
          value={implementation}
          onChange={(e) => setImplementation(e.target.value)}
          placeholder="Implementation (JSON)"
          rows={4}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
        />
      </div>
      <input
        value={changelog}
        onChange={(e) => setChangelog(e.target.value)}
        placeholder="Changelog (optional)"
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={publish.isPending || !version.trim()}
        className="w-full rounded-md bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {publish.isPending ? 'Publishing…' : 'Publish version'}
      </button>
    </form>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function versionLabel(versions: ToolVersion[], versionId: string): string {
  return versions.find((v) => v.id === versionId)?.version ?? versionId.slice(0, 8)
}

function Spinner() {
  return (
    <div className="flex h-32 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}
