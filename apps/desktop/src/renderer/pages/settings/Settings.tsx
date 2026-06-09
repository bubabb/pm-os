import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound, Plug, FolderOpen, Plus, Trash2, Loader2,
  Eye, EyeOff, CheckCircle2, AlertCircle, RefreshCw,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

interface Secret {
  id: string
  projectId: string
  name: string
  createdAt: string
  updatedAt: string
}

type IntegrationSource = 'github' | 'jira' | 'confluence' | 'notion' | 'onedrive'

interface IntegrationCredential {
  id: string
  projectId: string
  source: IntegrationSource
  label: string
  lastSyncedAt: string | null
  syncError: string | null
  createdAt: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const SOURCES: { value: IntegrationSource; label: string; hint: string }[] = [
  { value: 'github',     label: 'GitHub',     hint: 'Personal access token (repo, read:org)' },
  { value: 'jira',       label: 'Jira',        hint: 'Atlassian API token' },
  { value: 'confluence', label: 'Confluence',  hint: 'Atlassian API token' },
  { value: 'notion',     label: 'Notion',      hint: 'Notion integration secret' },
  { value: 'onedrive',   label: 'OneDrive',    hint: 'Microsoft Graph access token' },
]

const SOURCE_COLORS: Record<IntegrationSource, string> = {
  github:     'bg-zinc-800 text-zinc-100',
  jira:       'bg-blue-900 text-blue-200',
  confluence: 'bg-blue-700 text-blue-100',
  notion:     'bg-zinc-700 text-zinc-100',
  onedrive:   'bg-sky-800 text-sky-200',
}

type Tab = 'apikeys' | 'integrations' | 'project'

// ── Main component ────────────────────────────────────────────────────────────

export default function Settings() {
  const { currentProject, archiveProject } = useProjectStore()
  const [tab, setTab] = useState<Tab>('apikeys')

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
          { id: 'apikeys' as Tab,      label: 'API Keys',     icon: KeyRound },
          { id: 'integrations' as Tab, label: 'Integrations', icon: Plug },
          { id: 'project' as Tab,      label: 'Project',      icon: FolderOpen },
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

      {tab === 'apikeys'      && <ApiKeysTab projectId={currentProject.id} />}
      {tab === 'integrations' && <IntegrationsTab projectId={currentProject.id} />}
      {tab === 'project'      && <ProjectTab project={currentProject} onArchive={archiveProject} />}
    </div>
  )
}

// ── API Keys Tab ──────────────────────────────────────────────────────────────

function ApiKeysTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const { data: secrets = [], isLoading } = useQuery<Secret[]>({
    queryKey: ['secrets', projectId],
    queryFn: () => api.get(`/projects/${projectId}/secrets`),
  })

  const add = useMutation({
    mutationFn: (body: { name: string; value: string }) =>
      api.post(`/projects/${projectId}/secrets`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['secrets', projectId] })
      setName('')
      setValue('')
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const remove = useMutation({
    mutationFn: (secretId: string) =>
      api.delete(`/projects/${projectId}/secrets/${secretId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['secrets', projectId] }),
    onError: (e: Error) => setFormError(e.message),
  })

  const anthropicKey = secrets.find((s) => s.name === 'ANTHROPIC_API_KEY')
  const otherSecrets = secrets.filter((s) => s.name !== 'ANTHROPIC_API_KEY')

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !value.trim()) {
      setFormError('Name and value are required.')
      return
    }
    add.mutate({ name: name.trim(), value: value.trim() })
  }

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-6">
      {/* ANTHROPIC_API_KEY callout */}
      <div className={`rounded-lg border p-4 ${
        anthropicKey
          ? 'border-emerald-800 bg-emerald-950/30'
          : 'border-amber-800 bg-amber-950/30'
      }`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {anthropicKey
              ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              : <AlertCircle className="h-4 w-4 text-amber-400" />}
            <span className="text-sm font-medium text-foreground">ANTHROPIC_API_KEY</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Required</span>
          </div>
          {anthropicKey && (
            <button
              onClick={() => remove.mutate(anthropicKey.id)}
              disabled={remove.isPending}
              className="flex items-center gap-1 text-xs text-destructive hover:opacity-80 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" /> Remove
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {anthropicKey
            ? `Set ${formatDate(anthropicKey.createdAt)} — PM Command Center AI features are active.`
            : 'Not set — PM Command Center AI features (digest, NL queries, delegate) are disabled until this key is added.'}
        </p>
        {!anthropicKey && (
          <QuickAddForm
            label="Add ANTHROPIC_API_KEY"
            fixedName="ANTHROPIC_API_KEY"
            onAdd={(value) => add.mutate({ name: 'ANTHROPIC_API_KEY', value })}
            isPending={add.isPending}
          />
        )}
      </div>

      {/* Other secrets */}
      {otherSecrets.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-foreground">Other secrets</h2>
          <div className="divide-y divide-border rounded-lg border border-border">
            {otherSecrets.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="text-sm font-mono text-foreground">{s.name}</span>
                  <span className="ml-3 text-xs text-muted-foreground">Added {formatDate(s.createdAt)}</span>
                </div>
                <button
                  onClick={() => remove.mutate(s.id)}
                  disabled={remove.isPending}
                  className="text-destructive hover:opacity-80 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Add secret form */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">Add secret</h2>
        <form onSubmit={handleAdd} className="space-y-3">
          <input
            type="text"
            placeholder="Secret name (e.g. GITHUB_TOKEN)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
          />
          <div className="relative">
            <input
              type={showValue ? 'text' : 'password'}
              placeholder="Secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => setShowValue((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <button
            type="submit"
            disabled={add.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add secret
          </button>
        </form>
      </section>
    </div>
  )
}

// ── Integrations Tab ──────────────────────────────────────────────────────────

function IntegrationsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [source, setSource] = useState<IntegrationSource>('github')
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const { data: credentials = [], isLoading } = useQuery<IntegrationCredential[]>({
    queryKey: ['integrations', projectId],
    queryFn: () => api.get(`/projects/${projectId}/integrations`),
  })

  const add = useMutation({
    mutationFn: (body: { source: IntegrationSource; label: string; token: string }) =>
      api.post(`/projects/${projectId}/integrations`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integrations', projectId] })
      setLabel('')
      setToken('')
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const remove = useMutation({
    mutationFn: (credentialId: string) =>
      api.delete(`/projects/${projectId}/integrations/${credentialId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations', projectId] }),
    onError: (e: Error) => setFormError(e.message),
  })

  async function handleSync(credentialId: string, srcSource: IntegrationSource) {
    setSyncingId(credentialId)
    try {
      await api.post(`/projects/${projectId}/integrations/sync`, { source: srcSource })
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncingId(null)
      qc.invalidateQueries({ queryKey: ['integrations', projectId] })
    }
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim() || !token.trim()) {
      setFormError('Label and token are required.')
      return
    }
    add.mutate({ source, label: label.trim(), token: token.trim() })
  }

  const selectedSource = SOURCES.find((s) => s.value === source)!

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-6">
      {/* Existing credentials */}
      {credentials.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-medium text-foreground">Connected sources</h2>
          <div className="divide-y divide-border rounded-lg border border-border">
            {credentials.map((cred) => (
              <div key={cred.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${SOURCE_COLORS[cred.source]}`}>
                    {SOURCES.find((s) => s.value === cred.source)?.label ?? cred.source}
                  </span>
                  <div>
                    <p className="text-sm text-foreground">{cred.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {cred.lastSyncedAt
                        ? `Last synced ${formatDate(cred.lastSyncedAt)}`
                        : 'Never synced'}
                      {cred.syncError && (
                        <span className="ml-2 text-destructive">· {cred.syncError}</span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleSync(cred.id, cred.source)}
                    disabled={syncingId === cred.id}
                    title="Sync now"
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    {syncingId === cred.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <RefreshCw className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => remove.mutate(cred.id)}
                    disabled={remove.isPending}
                    className="rounded p-1 text-destructive hover:bg-accent disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <Plug className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add a source below to start pulling data into the PM Command Center.
          </p>
        </div>
      )}

      {/* Add credential form */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-foreground">Add integration</h2>
        <form onSubmit={handleAdd} className="space-y-3">
          {/* Source picker */}
          <div className="grid grid-cols-5 gap-2">
            {SOURCES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSource(s.value)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  source === s.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{selectedSource.hint}</p>

          <input
            type="text"
            placeholder="Label (e.g. My Org GitHub)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
          />

          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              placeholder="Access token / API key"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 font-mono text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {formError && <p className="text-xs text-destructive">{formError}</p>}

          <button
            type="submit"
            disabled={add.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Connect {selectedSource.label}
          </button>
        </form>
      </section>
    </div>
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

function QuickAddForm({
  label, fixedName, onAdd, isPending,
}: {
  label: string
  fixedName: string
  onAdd: (value: string) => void
  isPending: boolean
}) {
  const [val, setVal] = useState('')
  const [show, setShow] = useState(false)

  function handle(e: React.FormEvent) {
    e.preventDefault()
    if (val.trim()) onAdd(val.trim())
  }

  return (
    <form onSubmit={handle} className="mt-3 flex gap-2">
      <div className="relative flex-1">
        <input
          type={show ? 'text' : 'password'}
          placeholder={label}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 font-mono text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
      <button
        type="submit"
        disabled={isPending || !val.trim()}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        Save
      </button>
    </form>
  )
}

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
