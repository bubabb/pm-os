import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plug, Loader2, RefreshCw, CloudOff } from 'lucide-react'
import type { ClassifiedItem } from '@creare/integrations'
import { useProjectStore } from '../../store/projects'
import { useDashboardStore } from '../../store/dashboard'
import { api } from '../../lib/api'
import { toast } from '../../components/ui/Toast'
import { ContextStrip, formatRelativeTime } from './ContextStrip'
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
  const syncAndRefresh  = useDashboardStore((s) => s.syncAndRefresh)
  const setDelegating   = useDashboardStore((s) => s.setDelegating)
  const delegate        = useDashboardStore((s) => s.delegate)
  const acknowledge     = useDashboardStore((s) => s.acknowledge)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const projectId = currentProject?.id ?? null

  useEffect(() => {
    if (currentProject) load(currentProject.id)
  }, [currentProject?.id, load])

  // The dashboard store has no queryClient, so cross-tab cache invalidation
  // (Agents → Tasks list, Boards → Gantt timeline) happens here in the
  // component layer, wrapped in TanStack mutations.
  function invalidateTaskCaches(pid: string) {
    void queryClient.invalidateQueries({ queryKey: ['tasks', pid] })
    void queryClient.invalidateQueries({ queryKey: ['timeline', pid] }) // Gantt reads timeline
  }

  // Delegate → backend creates a real `[Agent] …` task. The drawer shows the
  // success state with a "View in Agents" action; the toast confirms it.
  const delegateMutation = useMutation({
    mutationFn: ({ item, action }: { item: ClassifiedItem; action: string }) => {
      if (!projectId) throw new Error('No project selected')
      return delegate(projectId, item, action)
    },
    onSuccess: () => {
      if (projectId) invalidateTaskCaches(projectId)
      toast.success('Agent task created — track it in Agents → Tasks')
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create agent task')
    },
  })

  // Risk "Handle it" → creates a real human task (same create-task endpoint
  // the Agents page uses), then acknowledges the risk locally.
  const handleRiskMutation = useMutation({
    mutationFn: (item: ClassifiedItem) => {
      if (!projectId) throw new Error('No project selected')
      return api.post<{ id: string }>(`/projects/${projectId}/tasks`, {
        title: item.entity.title,
        description: `${item.suggestedAction}\n\nSource: ${item.entity.source} · ${item.entity.entityType}${item.riskType ? `\nRisk: ${item.riskType}` : ''}`,
        type: 'human',
      })
    },
    onSuccess: (_task, item) => {
      if (projectId) {
        acknowledge(projectId, `${item.entity.source}-${item.entity.entityId}`)
        invalidateTaskCaches(projectId)
      }
      toast.success('Human task created — view it in Agents → Tasks')
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create task')
    },
  })

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

  if (!data) return null

  const { sprintContext, classified, agentActivity, digest, integrations } = data

  // Onboarding state 1 — nothing connected yet
  if (integrations.connectedCount === 0) {
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
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Go to Connections
        </button>
      </div>
    )
  }

  // Onboarding state 2 — connected, but nothing synced yet. Sync must be
  // reachable from here (the ContextStrip refresh only renders in state 3).
  if (integrations.syncedItemCount === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-muted p-4">
          <CloudOff className="h-8 w-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {integrations.connectedCount === 1
              ? 'Integration connected — no data synced yet'
              : `${integrations.connectedCount} integrations connected — no data synced yet`}
          </h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Run a sync to pull your work items in. Only open issues and pull requests are synced —
            if everything is closed, the dashboard will stay empty.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Last synced {formatRelativeTime(integrations.lastSyncedAt)}
          </p>
        </div>
        <button
          onClick={() => syncAndRefresh(currentProject.id)}
          disabled={isRefreshing}
          aria-label={isRefreshing ? 'Sync in progress' : 'Sync now'}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    )
  }

  async function handleDelegate(item: ClassifiedItem | null, action: string) {
    if (!currentProject || !item) return
    // mutateAsync so the drawer can await the result and flip to its success
    // state; rejections are toasted in onError and caught by the drawer.
    await delegateMutation.mutateAsync({ item, action })
  }

  function handleHandle(item: ClassifiedItem) {
    handleRiskMutation.mutate(item)
  }

  function handleDismiss(item: ClassifiedItem) {
    if (!currentProject) return
    acknowledge(currentProject.id, `${item.entity.source}-${item.entity.entityId}`)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Context strip */}
      <ContextStrip
        sprintContext={sprintContext}
        integrationsLastSyncedAt={integrations.lastSyncedAt}
        isRefreshing={isRefreshing}
        onRefresh={() => syncAndRefresh(currentProject.id)}
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
            onAcknowledge={(id) => acknowledge(currentProject.id, id)}
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
          onDismiss={handleDismiss}
          onDelegate={setDelegating}
          isHandling={handleRiskMutation.isPending}
        />
      </div>

      {/* Delegate config drawer */}
      {delegatingItem && (
        <DelegateConfigDrawer
          item={delegatingItem}
          onConfirm={(action) => handleDelegate(delegatingItem, action)}
          onViewAgents={() => {
            setDelegating(null)
            navigate('/agents')
          }}
          onClose={() => setDelegating(null)}
        />
      )}
    </div>
  )
}
