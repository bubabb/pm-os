import { create } from 'zustand'
import { api } from '../lib/api'
import { toast } from '../components/ui/Toast'
import type { ClassifiedItem } from '@pm-os/integrations'

// Matches DashboardResponse from @pm-os/reporting
interface SprintContext {
  activeSprint: { name: string; dayNumber: number; totalDays: number; endsAt: string } | null
  atRiskMilestones: { title: string; daysUntilDue: number; status: string }[]
  overnightDelta: number
  lastSyncedAt: string | null
}

interface TraceStub {
  id: string
  taskTitle: string | null
  agentWorkspaceName: string
  status: string
  startedAt: string
  durationMs: number | null
  costCents: number
}

/** Summary of connected integrations — drives the dashboard onboarding states. */
export interface IntegrationsSummary {
  connectedCount: number
  syncedItemCount: number
  lastSyncedAt: string | null
}

/** One row from GET /projects/:id/integrations/status */
interface IntegrationSyncStatus {
  credentialId: string
  source: string
  status: 'idle' | 'syncing' | 'error'
  lastSyncedAt: string | null
  lastErrorMessage: string | null
}

export interface DashboardData {
  sprintContext: SprintContext
  classified: {
    doNow: ClassifiedItem[]
    delegate: ClassifiedItem[]
    risks: ClassifiedItem[]
  }
  agentActivity: { running: TraceStub[]; completedToday: TraceStub[]; failed: TraceStub[] }
  digest: { morningBrief: string | null; isStale: boolean; generatedAt: string | null }
  hasIntegrations: boolean
  integrations: IntegrationsSummary
}

interface DashboardStore {
  data: DashboardData | null
  /** Which project `data` belongs to — lets load() keep showing fresh data during a background reload. */
  loadedProjectId: string | null
  isLoading: boolean
  /** True from the moment a sync is triggered until sources finish syncing AND the dashboard reloads. */
  isRefreshing: boolean
  error: string | null
  delegatingItem: ClassifiedItem | null
  acknowledgedIds: Set<string>
  load: (projectId: string) => Promise<void>
  /**
   * Trigger a sync (fire-and-forget on the backend), poll integration status
   * until no source reports `syncing` (or the poll times out), reload the
   * dashboard, and toast the outcome. The spinner (`isRefreshing`) stays on
   * until the dashboard has actually been reloaded.
   */
  syncAndRefresh: (projectId: string) => Promise<void>
  setDelegating: (item: ClassifiedItem | null) => void
  /**
   * POST the delegation (backend creates a real `[Agent] …` task) and
   * acknowledge the item locally. Returns the created task id so the
   * component layer can invalidate TanStack caches, toast, and offer
   * navigation — this store has no queryClient, so cache invalidation
   * deliberately lives in the component.
   */
  delegate: (projectId: string, item: ClassifiedItem, action: string) => Promise<{ taskId: string }>
  acknowledge: (projectId: string, entityId: string) => void
}

const SYNC_POLL_INTERVAL_MS = 1_500
const SYNC_POLL_TIMEOUT_MS = 120_000
/** Grace window for the fire-and-forget sync to actually flip a source into `syncing`. */
const SYNC_GRACE_MS = 6_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Acknowledged-id persistence ───────────────────────────────────────────────
// Dismissals survive reloads: ids live in localStorage, keyed per project.

const ACK_KEY_PREFIX = 'pmos_ack_'

function loadAckIds(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${ACK_KEY_PREFIX}${projectId}`)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

function saveAckIds(projectId: string, ids: Set<string>): void {
  try {
    localStorage.setItem(`${ACK_KEY_PREFIX}${projectId}`, JSON.stringify([...ids]))
  } catch {
    // Storage unavailable (quota/private mode) — dismissals stay in-memory for this session.
  }
}

/**
 * Poll integration status until no source is `syncing`. Because the sync POST
 * is fire-and-forget, the first polls may land before any source flips to
 * `syncing` — so we keep polling through a grace window unless we have already
 * seen a sync in flight or `lastSyncedAt` advanced past the pre-sync baseline.
 * Returns the first error message encountered, or null on a clean finish.
 */
async function pollUntilSynced(
  projectId: string,
  baselineLastSyncedAt: string | null
): Promise<string | null> {
  const startedAt = Date.now()
  const baselineMs = baselineLastSyncedAt ? new Date(baselineLastSyncedAt).getTime() : 0
  let sawSyncing = false

  for (;;) {
    await sleep(SYNC_POLL_INTERVAL_MS)
    const statuses = await api.get<IntegrationSyncStatus[]>(
      `/projects/${projectId}/integrations/status`
    )

    const anySyncing = statuses.some((s) => s.status === 'syncing')
    if (anySyncing) {
      sawSyncing = true
    } else {
      const advanced = statuses.some(
        (s) => s.lastSyncedAt !== null && new Date(s.lastSyncedAt).getTime() > baselineMs
      )
      const graceOver = Date.now() - startedAt >= SYNC_GRACE_MS
      if (sawSyncing || advanced || graceOver || statuses.length === 0) {
        const errored = statuses.find((s) => s.status === 'error')
        return errored ? (errored.lastErrorMessage ?? `${errored.source} sync failed`) : null
      }
    }

    if (Date.now() - startedAt >= SYNC_POLL_TIMEOUT_MS) {
      return 'Sync timed out — data may still be updating in the background'
    }
  }
}

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  data: null,
  loadedProjectId: null,
  isLoading: false,
  isRefreshing: false,
  error: null,
  delegatingItem: null,
  acknowledgedIds: new Set(),

  load: async (projectId) => {
    // Keep rendering existing data for this project while we reload in the
    // background; only blank to the full-screen spinner on a true cold load
    // (or when the project changed and the cached data is for another project).
    const { data: existing, loadedProjectId } = get()
    if (existing && loadedProjectId === projectId) {
      set({ error: null, acknowledgedIds: loadAckIds(projectId) })
    } else {
      set({ data: null, isLoading: true, error: null, acknowledgedIds: loadAckIds(projectId) })
    }
    try {
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, loadedProjectId: projectId, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load dashboard', isLoading: false })
    }
  },

  syncAndRefresh: async (projectId) => {
    if (get().isRefreshing) return
    set({ isRefreshing: true })

    const baselineLastSyncedAt = get().data?.integrations?.lastSyncedAt ?? null

    try {
      // Fire-and-forget on the backend — returns immediately.
      await api.post(`/projects/${projectId}/integrations/sync`, {})

      // Wait for the sync to actually finish before touching the dashboard.
      const syncError = await pollUntilSynced(projectId, baselineLastSyncedAt)

      // Reload the dashboard with whatever the sync produced.
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, loadedProjectId: projectId, isRefreshing: false })

      if (syncError) {
        toast.error(syncError)
      } else {
        toast.success('Synced')
      }
    } catch (err) {
      set({ isRefreshing: false })
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    }
  },

  setDelegating: (item) => set({ delegatingItem: item }),

  delegate: async (projectId, item, action) => {
    const result = await api.post<{ ok: boolean; taskId: string }>(
      `/projects/${projectId}/dashboard/delegate`,
      { entity: item.entity, suggestedAction: action },
    )
    // Acknowledge so the item leaves the panels; the drawer stays open to show
    // its success state (the component closes it when the user is done).
    const id = `${item.entity.source}-${item.entity.entityId}`
    const acknowledgedIds = new Set([...get().acknowledgedIds, id])
    saveAckIds(projectId, acknowledgedIds)
    set({ acknowledgedIds })
    return { taskId: result.taskId }
  },

  acknowledge: (projectId, entityId) => {
    const acknowledgedIds = new Set([...get().acknowledgedIds, entityId])
    saveAckIds(projectId, acknowledgedIds)
    set({ acknowledgedIds })
  },
}))
