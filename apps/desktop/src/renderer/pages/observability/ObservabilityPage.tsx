import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity, Loader2, CheckCircle2, XCircle, Clock,
  ChevronDown, ChevronRight, ShieldCheck, List,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

type TraceStatus = 'running' | 'completed' | 'failed'

interface Trace {
  id: string
  taskId: string | null
  agentWorkspaceId: string
  projectId: string
  status: TraceStatus
  inputTokens: number
  outputTokens: number
  costCents: number
  durationMs: number | null
  startedAt: string
  completedAt: string | null
  createdAt: string
  workspaceName: string | null
}

type TraceEventType = 'llm_call' | 'tool_call' | 'tool_result' | 'human_message' | 'error' | 'checkpoint'

interface TraceEvent {
  id: string
  traceId: string
  type: TraceEventType
  sequenceNumber: number
  payload: string
  durationMs: number | null
  createdAt: string
}

interface EventLogEntry {
  id: string
  type: string
  domain: string
  projectId: string | null
  actorType: string
  actorId: string | null
  resourceType: string | null
  resourceId: string | null
  payload: string
  createdAt: string
}

interface AuditEntry {
  id: string
  projectId: string | null
  actorType: string
  actorId: string | null
  action: string
  resourceType: string
  resourceId: string
  metadata: string
  ipAddress: string | null
  createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRACE_STATUS_CFG: Record<TraceStatus, { label: string; cls: string; icon: React.ElementType }> = {
  running:   { label: 'Running',   cls: 'bg-blue-100 text-blue-700',       icon: Clock },
  completed: { label: 'Completed', cls: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  failed:    { label: 'Failed',    cls: 'bg-red-100 text-red-700',         icon: XCircle },
}

const TRACE_EVENT_COLORS: Record<TraceEventType, string> = {
  llm_call:      'border-l-violet-400',
  tool_call:     'border-l-blue-400',
  tool_result:   'border-l-emerald-400',
  human_message: 'border-l-amber-400',
  error:         'border-l-red-500',
  checkpoint:    'border-l-zinc-400',
}

type PageTab = 'traces' | 'event-log' | 'audit-log'

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ObservabilityPage() {
  const { currentProject } = useProjectStore()
  const [tab, setTab] = useState<PageTab>('traces')

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view observability data.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground">Observability</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Agent traces, event log, and audit trail for {currentProject.name}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border bg-card px-6">
        {([
          { id: 'traces'    as PageTab, label: 'Traces' },
          { id: 'event-log' as PageTab, label: 'Event Log' },
          { id: 'audit-log' as PageTab, label: 'Audit Log' },
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
        {tab === 'traces'    && <TracesTab projectId={currentProject.id} />}
        {tab === 'event-log' && <EventLogTab projectId={currentProject.id} />}
        {tab === 'audit-log' && <AuditLogTab projectId={currentProject.id} />}
      </div>
    </div>
  )
}

// ── Traces Tab ────────────────────────────────────────────────────────────────

function TracesTab({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<TraceStatus | 'all'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: allTraces = [], isLoading } = useQuery<Trace[]>({
    queryKey: ['traces', projectId],
    queryFn: () => api.get(`/projects/${projectId}/traces`),
    refetchInterval: 10_000,
  })

  const { data: traceEvts = [], isFetching: evtsFetching } = useQuery<TraceEvent[]>({
    queryKey: ['trace-events', expanded],
    queryFn: () => api.get(`/projects/${projectId}/traces/${expanded}/events`),
    enabled: expanded !== null,
  })

  const displayed = filter === 'all' ? allTraces : allTraces.filter((t) => t.status === filter)

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {(['all', 'running', 'completed', 'failed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
              filter === s
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {s === 'all' ? 'All' : TRACE_STATUS_CFG[s].label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {displayed.length} trace{displayed.length !== 1 ? 's' : ''}
        </span>
      </div>

      {displayed.length === 0 ? (
        <EmptyState icon={Activity} title="No traces" desc="Agent execution traces will appear here as workspaces run tasks." />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {displayed.map((trace) => {
            const cfg = TRACE_STATUS_CFG[trace.status]
            const StatusIcon = cfg.icon
            const isExpanded = expanded === trace.id
            const totalTokens = trace.inputTokens + trace.outputTokens
            const costDollars = (trace.costCents / 100).toFixed(4)

            return (
              <div key={trace.id}>
                <div
                  className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/30"
                  onClick={() => setExpanded(isExpanded ? null : trace.id)}
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <StatusIcon className={`h-4 w-4 shrink-0 ${trace.status === 'running' ? 'text-blue-600 animate-pulse' : trace.status === 'failed' ? 'text-red-500' : 'text-emerald-600'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {trace.workspaceName ?? trace.agentWorkspaceId.slice(0, 8)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(trace.startedAt)}
                      {trace.durationMs !== null && ` · ${(trace.durationMs / 1000).toFixed(1)}s`}
                      {totalTokens > 0 && ` · ${totalTokens.toLocaleString()} tokens`}
                      {trace.costCents > 0 && ` · $${costDollars}`}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>{cfg.label}</span>
                </div>

                {isExpanded && (
                  <div className="border-t border-border/50 bg-muted/20 px-6 py-3">
                    <div className="mb-2 grid grid-cols-4 gap-3 text-xs">
                      <MetricCell label="Input tokens"  value={trace.inputTokens.toLocaleString()} />
                      <MetricCell label="Output tokens" value={trace.outputTokens.toLocaleString()} />
                      <MetricCell label="Duration"      value={trace.durationMs !== null ? `${(trace.durationMs / 1000).toFixed(2)}s` : '—'} />
                      <MetricCell label="Cost"          value={trace.costCents > 0 ? `$${costDollars}` : '—'} />
                    </div>
                    {evtsFetching ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading events…
                      </div>
                    ) : traceEvts.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No trace events recorded.</p>
                    ) : (
                      <div className="space-y-1.5 mt-2">
                        {traceEvts.map((evt) => {
                          let parsed: Record<string, unknown> = {}
                          try { parsed = JSON.parse(evt.payload) } catch { /* ignore */ }
                          return (
                            <div
                              key={evt.id}
                              className={`rounded border-l-4 bg-background px-3 py-2 ${TRACE_EVENT_COLORS[evt.type]}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-foreground capitalize">{evt.type.replace('_', ' ')}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  #{evt.sequenceNumber}
                                  {evt.durationMs !== null && ` · ${evt.durationMs}ms`}
                                </span>
                              </div>
                              {Object.keys(parsed).length > 0 && (
                                <pre className="mt-1 overflow-auto text-[10px] text-muted-foreground max-h-20">
                                  {JSON.stringify(parsed, null, 2)}
                                </pre>
                              )}
                            </div>
                          )
                        })}
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

// ── Event Log Tab ─────────────────────────────────────────────────────────────

function EventLogTab({ projectId }: { projectId: string }) {
  const [domainFilter, setDomainFilter] = useState('')

  const { data: evtLog = [], isLoading } = useQuery<EventLogEntry[]>({
    queryKey: ['event-log', projectId, domainFilter],
    queryFn: () =>
      api.get(`/projects/${projectId}/event-log?limit=200${domainFilter ? `&domain=${domainFilter}` : ''}`),
    refetchInterval: 15_000,
  })

  const domains = [...new Set(evtLog.map((e) => e.domain))].sort()

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setDomainFilter('')}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${!domainFilter ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
        >
          All
        </button>
        {domains.map((d) => (
          <button
            key={d}
            onClick={() => setDomainFilter(d === domainFilter ? '' : d)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${domainFilter === d ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          >
            {d}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{evtLog.length} events</span>
      </div>

      {evtLog.length === 0 ? (
        <EmptyState icon={List} title="No events" desc="Domain events are recorded here as the system runs." />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border font-mono text-xs">
          {evtLog.map((evt) => (
            <div key={evt.id} className="flex items-start gap-3 px-4 py-2">
              <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                {new Date(evt.createdAt).toLocaleTimeString()}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {evt.domain}
              </span>
              <span className="flex-1 text-foreground">{evt.type}</span>
              {evt.resourceType && (
                <span className="shrink-0 text-muted-foreground">
                  {evt.resourceType}/{evt.resourceId?.slice(0, 8)}
                </span>
              )}
              <span className="shrink-0 text-muted-foreground/60 capitalize">{evt.actorType}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────

function AuditLogTab({ projectId }: { projectId: string }) {
  const { data: auditEntries = [], isLoading } = useQuery<AuditEntry[]>({
    queryKey: ['audit-log', projectId],
    queryFn: () => api.get(`/projects/${projectId}/audit-log?limit=200`),
    refetchInterval: 30_000,
  })

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Audit Trail</h2>
        <span className="text-xs text-muted-foreground">{auditEntries.length} entries · immutable</span>
      </div>

      {auditEntries.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No audit entries"
          desc="Authorization and compliance events are recorded here."
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {auditEntries.map((entry) => (
            <div key={entry.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">{entry.action}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {entry.resourceType}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.actorType}{entry.actorId ? ` · ${entry.actorId.slice(0, 12)}` : ''}
                    {entry.ipAddress && ` · ${entry.ipAddress}`}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(entry.createdAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-foreground tabular-nums">{value}</p>
    </div>
  )
}

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
