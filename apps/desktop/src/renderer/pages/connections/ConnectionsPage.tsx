import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles, Plug, Plus, Trash2, Loader2,
  Eye, EyeOff, CheckCircle2, AlertCircle, ArrowRight,
} from 'lucide-react'
import { api } from '../../lib/api'
import { Badge, BADGE_SOURCE_CLASSES, SOURCE_LABELS } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { Field } from '../../components/ui/Field'

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

// ── Source config ─────────────────────────────────────────────────────────────

interface SourceField {
  key: string
  label: string
  required: boolean
  password?: boolean
  placeholder?: string
  hint?: string
}

interface SourceConfig {
  source: ConnectionSource
  name: string
  description: string
  fields: SourceField[]
  /** Which field keys (besides token) go into metadata; empty values are dropped. */
  metadataKeys: string[]
}

const SOURCES: SourceConfig[] = [
  {
    source: 'github',
    name: 'GitHub',
    description: 'Connect a GitHub account to pull issues, PRs, and commits.',
    fields: [
      { key: 'token', label: 'Token', required: true, password: true, placeholder: 'ghp_…', hint: 'Personal access token — scopes: repo, read:org' },
    ],
    metadataKeys: [],
  },
  {
    source: 'jira',
    name: 'Jira',
    description: 'Connect a Jira site to pull issues, sprints, and status changes.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://yoursite.atlassian.net' },
      { key: 'email',   label: 'Email',    required: true, placeholder: 'you@company.com' },
      { key: 'token',   label: 'Token',    required: true, password: true, placeholder: 'API token', hint: 'Atlassian API token' },
    ],
    metadataKeys: ['baseUrl', 'email'],
  },
  {
    source: 'confluence',
    name: 'Confluence',
    description: 'Connect a Confluence site to pull pages and docs.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'https://yoursite.atlassian.net' },
      { key: 'email',   label: 'Email',    required: true, placeholder: 'you@company.com' },
      { key: 'token',   label: 'Token',    required: true, password: true, placeholder: 'API token', hint: 'Atlassian API token' },
    ],
    metadataKeys: ['baseUrl', 'email'],
  },
  {
    source: 'notion',
    name: 'Notion',
    description: 'Connect a Notion workspace to pull tasks and docs.',
    fields: [
      { key: 'token', label: 'Token', required: true, password: true, placeholder: 'secret_…', hint: 'Notion integration secret' },
    ],
    metadataKeys: [],
  },
  {
    source: 'onedrive',
    name: 'OneDrive',
    description: 'Connect OneDrive to pull documents and files.',
    fields: [
      { key: 'token', label: 'Token', required: true, password: true, placeholder: 'Access token', hint: 'Microsoft Graph access token' },
    ],
    metadataKeys: [],
  },
]

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-xl font-semibold text-foreground">Connections</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Global accounts and keys — shared across all projects. Bind them to a project in
        Settings → Sources.
      </p>

      <div className="space-y-8">
        <ClaudeSection />
        <ConnectedAccountsSection />
      </div>
    </div>
  )
}

// ── Section 1: Claude (AI) ────────────────────────────────────────────────────

function ClaudeSection() {
  const qc = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)

  const { data: keys = [], isLoading, isError, error, refetch } = useQuery<string[]>({
    queryKey: ['globalSettings'],
    queryFn: () => api.get('/settings/keys'),
  })

  const save = useMutation({
    mutationFn: (value: string) =>
      api.put('/settings/ANTHROPIC_API_KEY', { value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['globalSettings'] })
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const remove = useMutation({
    mutationFn: () => api.delete('/settings/ANTHROPIC_API_KEY'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['globalSettings'] })
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const hasKey = keys.includes('ANTHROPIC_API_KEY')

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">Claude (AI)</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Your Anthropic API key powers the PM planning and classification — actionable items,
        risk detection, and delegate suggestions — across all projects.
      </p>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
      ) : (
        <div className={`rounded-lg border p-4 ${
          hasKey
            ? 'border-emerald-500/40 bg-emerald-500/5'
            : 'border-amber-500/40 bg-amber-500/5'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {hasKey
                ? <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                : <AlertCircle className="h-4 w-4 text-amber-400" aria-hidden="true" />}
              <span className="text-sm font-medium text-foreground">Anthropic API key</span>
              <Badge variant={hasKey ? 'success' : 'warning'}>
                {hasKey ? 'Connected' : 'Not set'}
              </Badge>
            </div>
            {hasKey && (
              <button
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="flex items-center gap-1 text-xs text-destructive hover:opacity-80 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" /> Remove
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {hasKey
              ? 'Set — AI planning features are active for all projects.'
              : 'Not set — AI planning features (digest, NL queries, delegate) are disabled until this key is added.'}
          </p>
          {!hasKey && (
            <QuickAddForm
              label="sk-ant-…"
              onAdd={(value) => save.mutate(value)}
              isPending={save.isPending}
            />
          )}
          {formError && <p className="mt-2 text-xs text-destructive">{formError}</p>}
        </div>
      )}
    </section>
  )
}

// ── Section 2: Connected accounts ─────────────────────────────────────────────

function ConnectedAccountsSection() {
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  const { data: connections = [], isLoading, isError, error, refetch } = useQuery<Connection[]>({
    queryKey: ['connections'],
    queryFn: () => api.get('/connections'),
  })

  const remove = useMutation({
    mutationFn: (connectionId: string) => api.delete(`/connections/${connectionId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      setListError(null)
    },
    onError: (e: Error) => setListError(e.message),
  })

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Connected accounts</h2>
        </div>
        <button
          onClick={() => { setFormOpen((o) => !o); setJustConnected(false) }}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          {formOpen ? 'Cancel' : 'Add account'}
        </button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Accounts are stored once, globally. Bind an account to a project (with a repo,
        project key, etc.) in that project&apos;s Settings → Sources.
      </p>

      {formOpen && (
        <AddAccountForm onDone={(connected) => { setFormOpen(false); setJustConnected(connected) }} />
      )}

      {justConnected && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
            Account connected
          </p>
          <NavLink
            to="/settings"
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Now add it to a project in Settings → Sources
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </NavLink>
        </div>
      )}

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
      ) : connections.length === 0 ? (
        !formOpen && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No accounts connected yet. Click &ldquo;Add account&rdquo; to connect GitHub, Jira,
              Confluence, Notion, or OneDrive.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              onRemove={() => remove.mutate(connection.id)}
              removePending={remove.isPending}
            />
          ))}
        </div>
      )}

      {listError && <p className="mt-2 text-xs text-destructive">{listError}</p>}
    </section>
  )
}

function ConnectionCard({
  connection, onRemove, removePending,
}: {
  connection: Connection
  onRemove: () => void
  removePending: boolean
}) {
  const metadata = parseMetadata(connection.metadata)
  const summary =
    connection.source === 'jira' || connection.source === 'confluence'
      ? metadata.baseUrl ?? null
      : null

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge source={connection.source}>{SOURCE_LABELS[connection.source]}</Badge>
          <div>
            <p className="flex items-center gap-1.5 text-sm text-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {connection.label}
            </p>
            <p className="text-xs text-muted-foreground">
              {summary ? `${summary} · ` : ''}Added {formatDate(connection.createdAt)}
            </p>
          </div>
        </div>
        <button
          onClick={onRemove}
          disabled={removePending}
          title="Remove"
          aria-label={`Remove ${connection.label}`}
          className="rounded p-1 text-destructive hover:bg-accent disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// ── Add account form ──────────────────────────────────────────────────────────

function AddAccountForm({ onDone }: { onDone: (connected: boolean) => void }) {
  const qc = useQueryClient()
  const [source, setSource] = useState<ConnectionSource>('github')
  const [values, setValues] = useState<Record<string, string>>({})
  const [label, setLabel] = useState('')
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const config = SOURCES.find((s) => s.source === source)!

  const add = useMutation({
    mutationFn: (body: { source: ConnectionSource; label: string; token: string; metadata: Record<string, string> }) =>
      api.post('/connections', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] })
      setValues({})
      setLabel('')
      setFormError(null)
      onDone(true)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  function handleSourceChange(next: ConnectionSource) {
    setSource(next)
    setValues({})
    setShown({})
    setFormError(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const missing = config.fields.filter((f) => f.required && !(values[f.key] ?? '').trim())
    if (missing.length > 0) {
      setFormError(`${missing.map((f) => f.label).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required.`)
      return
    }
    const metadata: Record<string, string> = {}
    for (const key of config.metadataKeys) {
      const v = (values[key] ?? '').trim()
      if (v) metadata[key] = v
    }
    add.mutate({
      source: config.source,
      label: label.trim() || config.name,
      token: (values.token ?? '').trim(),
      metadata,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-lg border border-border p-4">
      {/* Source picker */}
      <div className="flex flex-wrap gap-2">
        {SOURCES.map((s) => (
          <button
            key={s.source}
            type="button"
            onClick={() => handleSourceChange(s.source)}
            className={`rounded px-2 py-1 text-xs font-medium transition-opacity ${BADGE_SOURCE_CLASSES[s.source]} ${
              source === s.source ? 'ring-2 ring-primary' : 'opacity-50 hover:opacity-80'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{config.description}</p>

      {config.fields.map((field) => (
        <Field key={field.key} id={`account-${field.key}`} label={field.label} {...(field.hint ? { hint: field.hint } : {})}>
          <div className="relative">
            <input
              id={`account-${field.key}`}
              type={field.password && !shown[field.key] ? 'password' : 'text'}
              placeholder={field.placeholder ?? field.label}
              value={values[field.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
              className={`w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary ${
                field.password ? 'pr-10 font-mono' : ''
              }`}
            />
            {field.password && (
              <button
                type="button"
                onClick={() => setShown((s) => ({ ...s, [field.key]: !s[field.key] }))}
                aria-label={shown[field.key] ? `Hide ${field.label}` : `Show ${field.label}`}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {shown[field.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            )}
          </div>
        </Field>
      ))}

      <Field id="account-label" label="Label">
        <input
          id="account-label"
          type="text"
          placeholder={`Optional, defaults to "${config.name}"`}
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
        Connect {config.name}
      </button>
    </form>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function QuickAddForm({
  label, onAdd, isPending,
}: {
  label: string
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
          aria-label="Anthropic API key"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 font-mono text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide API key' : 'Show API key'}
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
