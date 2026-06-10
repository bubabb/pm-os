import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plug, Loader2 } from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { useDashboardStore } from '../../store/dashboard'
import { ContextStrip } from './ContextStrip'
import { DoNowPanel } from './DoNowPanel'
import { DelegatePanel } from './DelegatePanel'
import { DelegateConfigDrawer } from './DelegateConfigDrawer'
import { AgentActivityPanel } from './AgentActivityPanel'
import { RiskRadar } from './RiskRadar'

export default function PMCommandCenter() {
  const { currentProject } = useProjectStore()
  // Selector form so this page only re-renders when the slices it reads change
  const data            = useDashboardStore((s) => s.data)
  const isLoading       = useDashboardStore((s) => s.isLoading)
  const isRefreshing    = useDashboardStore((s) => s.isRefreshing)
  const error           = useDashboardStore((s) => s.error)
  const delegatingItem  = useDashboardStore((s) => s.delegatingItem)
  const acknowledgedIds = useDashboardStore((s) => s.acknowledgedIds)
  const load            = useDashboardStore((s) => s.load)
  const refresh         = useDashboardStore((s) => s.refresh)
  const setDelegating   = useDashboardStore((s) => s.setDelegating)
  const delegate        = useDashboardStore((s) => s.delegate)
  const acknowledge     = useDashboardStore((s) => s.acknowledge)
  const navigate = useNavigate()

  useEffect(() => {
    if (currentProject) load(currentProject.id)
  }, [currentProject?.id, load])

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view the dashboard.</p>
      </div>
    )
  }

  // Full-screen spinner only on a true cold load — when data is already in the
  // store, keep rendering it while load() refreshes in the background.
  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    )
  }

  // Onboarding state — no integrations configured
  if (data && !data.hasIntegrations) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-muted p-4">
          <Plug className="h-8 w-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">Connect your tools</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Add your Jira, GitHub, Confluence, Notion, or OneDrive credentials to start seeing
            actionable insights here.
          </p>
        </div>
        <button
          onClick={() => navigate('/connections')}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Go to Connections
        </button>
      </div>
    )
  }

  if (!data) return null

  const { sprintContext, classified, agentActivity, digest } = data

  async function handleDelegate(item: typeof delegatingItem, action: string) {
    if (!currentProject || !item) return
    await delegate(currentProject.id, item, action)
  }

  function handleHandle(item: (typeof classified.risks)[number]) {
    // Move to DO NOW by flipping bucket — for now just acknowledge so it's gone from risk radar
    // Domain 1 integration will create a human task in Phase 3
    const id = `${item.entity.source}-${item.entity.entityId}`
    acknowledge(id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Context strip */}
      <ContextStrip
        sprintContext={sprintContext}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(currentProject.id)}
      />

      {/* Digest stale banner */}
      {digest.isStale && digest.morningBrief && (
        <div className="border-b border-border bg-yellow-500/5 px-6 py-2 text-xs text-yellow-600 dark:text-yellow-400">
          Digest is stale — refresh to generate updated insights
        </div>
      )}

      {/* Main two-column area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left — DO NOW (primary, larger) */}
        <div className="flex w-[52%] flex-col border-r border-border overflow-hidden">
          <DoNowPanel
            items={classified.doNow}
            acknowledgedIds={acknowledgedIds}
            onAcknowledge={acknowledge}
          />
        </div>

        {/* Right — DELEGATE + AGENT ACTIVITY */}
        <div className="flex w-[48%] flex-col overflow-hidden divide-y divide-border">
          <div className="flex-1 overflow-y-auto">
            <DelegatePanel
              items={classified.delegate}
              acknowledgedIds={acknowledgedIds}
              onDelegate={setDelegating}
            />
          </div>
          <div className="overflow-y-auto max-h-56">
            <AgentActivityPanel
              running={agentActivity.running}
              completedToday={agentActivity.completedToday}
              failed={agentActivity.failed}
            />
          </div>
        </div>
      </div>

      {/* Risk Radar — full width bottom */}
      <div className="overflow-y-auto max-h-64 border-t border-border bg-card/30">
        <RiskRadar
          risks={classified.risks}
          acknowledgedIds={acknowledgedIds}
          onHandle={handleHandle}
          onDelegate={setDelegating}
        />
      </div>

      {/* Delegate config drawer */}
      {delegatingItem && (
        <DelegateConfigDrawer
          item={delegatingItem}
          onConfirm={(action) => handleDelegate(delegatingItem, action)}
          onClose={() => setDelegating(null)}
        />
      )}
    </div>
  )
}
