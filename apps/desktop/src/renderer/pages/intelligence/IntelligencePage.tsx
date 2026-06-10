import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FlaskConical, BrainCircuit, Loader2, ChevronDown, ChevronRight,
  Search, Plus, CheckCircle2, XCircle,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'
import { Badge, type BadgeVariant } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { Field } from '../../components/ui/Field'

// ── Types (API rows) ──────────────────────────────────────────────────────────

interface EvalRun {
  id: string
  projectId: string
  suite: string
  runner: string
  total: number
  passed: number
  passRate: number                       // 0..1
  avgScore: number                       // 0..1
  results: string                        // JSON: EvalCaseResult[]
  createdAt: string
}

interface EvalCaseResult {
  caseId: string
  output: string
  score: number
  passed: boolean
  durationMs: number
  detail?: string
}

type LearningSource = 'agent_run' | 'review' | 'eval' | 'manual'

interface Learning {
  id: string
  projectId: string
  source: LearningSource
  taskId: string | null
  title: string
  content: string
  tags: string                           // JSON: string[]
  createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SOURCE_CFG: Record<LearningSource, { label: string; variant: BadgeVariant }> = {
  agent_run: { label: 'Agent run', variant: 'info' },
  review:    { label: 'Review',    variant: 'warning' },
  eval:      { label: 'Eval',      variant: 'success' },
  manual:    { label: 'Manual',    variant: 'neutral' },
}

type PageTab = 'eval' | 'memory'

function passRateVariant(rate: number): BadgeVariant {
  if (rate >= 1)   return 'success'
  if (rate >= 0.5) return 'warning'
  return 'danger'
}

function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function parseResults(json: string): EvalCaseResult[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as EvalCaseResult[]) : []
  } catch {
    return []
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IntelligencePage() {
  const { currentProject } = useProjectStore()
  const [tab, setTab] = useState<PageTab>('eval')

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view eval runs and team memory.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground">Intelligence</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Eval runs and team memory for {currentProject.name}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border bg-card px-6">
        {([
          { id: 'eval'   as PageTab, label: 'Eval' },
          { id: 'memory' as PageTab, label: 'Memory' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`border-b-2 px-4 py-2.5 text-sm transition-colors ${
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'eval'   && <EvalTab projectId={currentProject.id} />}
        {tab === 'memory' && <MemoryTab projectId={currentProject.id} />}
      </div>
    </div>
  )
}

// ── Eval Tab ──────────────────────────────────────────────────────────────────

function EvalTab({ projectId }: { projectId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [suiteFilter, setSuiteFilter] = useState('')

  const { data: runs = [], isLoading, isError, error, refetch } = useQuery<EvalRun[]>({
    queryKey: ['eval-runs', projectId],
    queryFn: () => api.get(`/projects/${projectId}/eval-runs`),
    refetchInterval: 30_000,
  })

  if (isLoading) return <Spinner />
  if (isError)   return <QueryError message={(error as Error).message} onRetry={() => refetch()} />

  const suites = [...new Set(runs.map((r) => r.suite))].sort()
  const displayed = suiteFilter ? runs.filter((r) => r.suite === suiteFilter) : runs

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setSuiteFilter('')}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            !suiteFilter ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
          }`}
        >
          All suites
        </button>
        {suites.map((s) => (
          <button
            key={s}
            onClick={() => setSuiteFilter(s === suiteFilter ? '' : s)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              suiteFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {s}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {displayed.length} run{displayed.length !== 1 ? 's' : ''}
        </span>
      </div>

      {displayed.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No eval runs"
          desc="Eval runs are recorded here when suites execute — pass rates can then be tracked over time."
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {displayed.map((run) => {
            const isExpanded = expanded === run.id
            const results = isExpanded ? parseResults(run.results) : []
            return (
              <div key={run.id}>
                <div
                  className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/30"
                  onClick={() => setExpanded(isExpanded ? null : run.id)}
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <FlaskConical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{run.suite}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(run.createdAt)} · {run.runner} · avg score {(run.avgScore * 100).toFixed(0)}%
                    </p>
                  </div>
                  <Badge variant={passRateVariant(run.passRate)} className="shrink-0">
                    {run.passed}/{run.total} passed · {(run.passRate * 100).toFixed(0)}%
                  </Badge>
                </div>

                {isExpanded && (
                  <div className="border-t border-border/50 bg-muted/20 px-6 py-3">
                    {results.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No per-case results recorded.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {results.map((r) => (
                          <div
                            key={r.caseId}
                            className={`rounded border-l-4 bg-background px-3 py-2 ${
                              r.passed ? 'border-l-emerald-400' : 'border-l-red-500'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {r.passed
                                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
                                  : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />}
                                <span className="truncate text-[11px] font-semibold text-foreground">{r.caseId}</span>
                              </div>
                              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                                score {(r.score * 100).toFixed(0)}% · {r.durationMs}ms
                              </span>
                            </div>
                            {r.output && (
                              <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
                                {r.output}
                              </pre>
                            )}
                            {r.detail && <p className="mt-1 text-[10px] text-amber-300/80">{r.detail}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Memory Tab ────────────────────────────────────────────────────────────────

function MemoryTab({ projectId }: { projectId: string }) {
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<LearningSource | ''>('')
  const [showForm, setShowForm] = useState(false)

  // Free-text recall and source filtering are mutually exclusive server-side
  // (recall ranks across all sources), so a search clears the source filter.
  const params = new URLSearchParams()
  if (search.trim()) params.set('q', search.trim())
  else if (sourceFilter) params.set('source', sourceFilter)
  const qs = params.toString()

  const { data: items = [], isLoading, isError, error, refetch } = useQuery<Learning[]>({
    queryKey: ['learnings', projectId, qs],
    queryFn: () => api.get(`/projects/${projectId}/learnings${qs ? `?${qs}` : ''}`),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recall learnings…"
            aria-label="Recall learnings"
            className="w-56 rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        {(Object.keys(SOURCE_CFG) as LearningSource[]).map((s) => (
          <button
            key={s}
            onClick={() => setSourceFilter(s === sourceFilter ? '' : s)}
            disabled={!!search.trim()}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
              sourceFilter === s && !search.trim()
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {SOURCE_CFG[s].label}
          </button>
        ))}
        <button
          onClick={() => setShowForm((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Record learning
        </button>
      </div>

      {showForm && <RecordLearningForm projectId={projectId} onDone={() => setShowForm(false)} />}

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <QueryError message={(error as Error).message} onRetry={() => refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={BrainCircuit}
          title={search.trim() ? 'No matching learnings' : 'No learnings yet'}
          desc={
            search.trim()
              ? 'Try a different query — recall matches tags, titles, and content.'
              : 'Durable learnings from agent runs, reviews, and evals appear here.'
          }
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {items.map((l) => {
            const tags = parseTags(l.tags)
            const cfg = SOURCE_CFG[l.source]
            return (
              <div key={l.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{l.title}</span>
                      <Badge variant={cfg.variant}>{cfg.label}</Badge>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{l.content}</p>
                    {tags.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                        {tags.map((t) => (
                          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDate(l.createdAt)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RecordLearningForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const record = useMutation({
    mutationFn: () =>
      api.post(`/projects/${projectId}/learnings`, {
        source: 'manual',
        title: title.trim(),
        content: content.trim(),
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['learnings', projectId] })
      setFormError(null)
      onDone()
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const canSubmit = title.trim().length > 0 && content.trim().length > 0 && !record.isPending

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (canSubmit) record.mutate() }}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <Field id="learning-title" label="Title">
        <input
          id="learning-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Retry transient SQLite locks"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </Field>
      <Field id="learning-content" label="Content">
        <textarea
          id="learning-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={3}
          placeholder="What was learned, and why it matters for future work"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </Field>
      <Field id="learning-tags" label="Tags" hint="Comma-separated, used for recall ranking">
        <input
          id="learning-tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="sqlite, retries"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </Field>
      {formError && <p className="text-xs text-destructive">{formError}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {record.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Record
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function EmptyState({
  icon: Icon, title, desc,
}: {
  icon: React.ElementType
  title: string
  desc: string
}) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <Icon className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
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
