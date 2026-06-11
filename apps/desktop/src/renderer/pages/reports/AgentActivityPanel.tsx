import { useNavigate } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle, ArrowRight } from 'lucide-react'

interface TraceStub {
  id: string
  taskTitle: string | null
  agentWorkspaceName: string
  status: string
  startedAt: string
  durationMs: number | null
  costCents: number
}

interface Props {
  running: TraceStub[]
  completedToday: TraceStub[]
  failed: TraceStub[]
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function formatCost(cents: number): string {
  if (cents < 1) return '<$0.01'
  return `$${(cents / 100).toFixed(2)}`
}

function TraceRow({ trace, icon, onOpen }: { trace: TraceStub; icon: React.ReactNode; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open trace for ${trace.taskTitle ?? 'unnamed task'} in Observability`}
      className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {trace.taskTitle ?? 'Unnamed task'}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{trace.agentWorkspaceName}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[11px] text-muted-foreground">{formatDuration(trace.durationMs)}</p>
        <p className="text-[11px] text-muted-foreground">{formatCost(trace.costCents)}</p>
      </div>
    </button>
  )
}

export function AgentActivityPanel({ running, completedToday, failed }: Props) {
  const navigate = useNavigate()
  const total = running.length + completedToday.length + failed.length
  const openObservability = () => navigate('/observability')

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Agent Activity</h2>
        {total === 0 ? (
          <span className="text-xs text-muted-foreground">No activity today</span>
        ) : (
          <button
            type="button"
            onClick={openObservability}
            aria-label="View all agent activity in Observability"
            className="flex items-center gap-1 rounded text-xs text-primary/80 transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all in Observability
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>

      {running.length > 0 && (
        <div>
          <p className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Running ({running.length})
          </p>
          {running.map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              icon={<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              onOpen={openObservability}
            />
          ))}
        </div>
      )}

      {completedToday.length > 0 && (
        <div>
          <p className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Completed today ({completedToday.length})
          </p>
          {completedToday.slice(0, 5).map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
              onOpen={openObservability}
            />
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div>
          <p className="px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Failed ({failed.length})
          </p>
          {failed.slice(0, 3).map((t) => (
            <TraceRow
              key={t.id}
              trace={t}
              icon={<XCircle className="h-3.5 w-3.5 text-destructive" />}
              onOpen={openObservability}
            />
          ))}
        </div>
      )}

      {total === 0 && (
        <p className="px-4 py-4 text-xs text-muted-foreground">
          No agent tasks have run yet — activity will appear here once agents start running.
        </p>
      )}
    </div>
  )
}
