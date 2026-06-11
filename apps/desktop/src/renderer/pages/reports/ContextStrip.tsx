import { RefreshCw, AlertTriangle, Clock, Activity } from 'lucide-react'

interface SprintContext {
  activeSprint: { name: string; dayNumber: number; totalDays: number; endsAt: string } | null
  atRiskMilestones: { title: string; daysUntilDue: number; status: string }[]
  overnightDelta: number
  lastSyncedAt: string | null
}

interface Props {
  sprintContext: SprintContext
  /** Real integration sync time from dashboard.integrations.lastSyncedAt (not the cache-derived value). */
  integrationsLastSyncedAt: string | null
  isRefreshing: boolean
  onRefresh: () => void
}

/** Format an ISO timestamp as a coarse relative time ("just now", "5m ago", "2h ago", "3d ago"). */
export function formatRelativeTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return 'never'
  const diffMs = Date.now() - new Date(isoTimestamp).getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

export function ContextStrip({ sprintContext, integrationsLastSyncedAt, isRefreshing, onRefresh }: Props) {
  const { activeSprint, atRiskMilestones, overnightDelta } = sprintContext

  const lastSynced = formatRelativeTime(integrationsLastSyncedAt)

  return (
    <div className="flex items-center gap-6 border-b border-border bg-card/60 px-6 py-2.5 text-sm">
      {/* Sprint */}
      <div className="flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        {activeSprint ? (
          <span className="text-foreground">
            <span className="font-medium">{activeSprint.name}</span>
            <span className="ml-1 text-muted-foreground">
              · Day {activeSprint.dayNumber}/{activeSprint.totalDays}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">No active sprint</span>
        )}
      </div>

      {/* At-risk milestones */}
      {atRiskMilestones.length > 0 && (
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
          <span className="text-destructive">
            {atRiskMilestones[0]!.title}
            {atRiskMilestones[0]!.daysUntilDue >= 0
              ? ` · ${atRiskMilestones[0]!.daysUntilDue}d`
              : ' · overdue'}
          </span>
          {atRiskMilestones.length > 1 && (
            <span className="text-muted-foreground">+{atRiskMilestones.length - 1} more</span>
          )}
        </div>
      )}

      {/* Overnight delta */}
      {overnightDelta > 0 && (
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{overnightDelta}</span> new overnight
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Sync status */}
      <div className="flex items-center gap-2 text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        <span>{isRefreshing ? 'Syncing…' : `Last synced ${lastSynced}`}</span>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="ml-1 rounded p-0.5 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          aria-label={isRefreshing ? 'Sync in progress' : 'Sync now'}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </div>
  )
}
