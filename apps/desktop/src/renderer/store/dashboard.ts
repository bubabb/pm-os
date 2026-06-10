import { create } from 'zustand'
import { api } from '../lib/api'
import type { ClassifiedItem } from '@creare/integrations'

// Matches DashboardResponse from @creare/reporting
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
}

interface DashboardStore {
  data: DashboardData | null
  /** Which project `data` belongs to — lets load() keep showing fresh data during a background reload. */
  loadedProjectId: string | null
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
  delegatingItem: ClassifiedItem | null
  acknowledgedIds: Set<string>
  load: (projectId: string) => Promise<void>
  refresh: (projectId: string) => Promise<void>
  setDelegating: (item: ClassifiedItem | null) => void
  delegate: (projectId: string, item: ClassifiedItem, action: string) => Promise<void>
  acknowledge: (entityId: string) => void
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
      set({ error: null })
    } else {
      set({ data: null, isLoading: true, error: null })
    }
    try {
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, loadedProjectId: projectId, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load dashboard', isLoading: false })
    }
  },

  refresh: async (projectId) => {
    set({ isRefreshing: true })
    try {
      await api.post(`/projects/${projectId}/integrations/sync`, {})
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, loadedProjectId: projectId, isRefreshing: false })
    } catch {
      set({ isRefreshing: false })
    }
  },

  setDelegating: (item) => set({ delegatingItem: item }),

  delegate: async (projectId, item, action) => {
    await api.post(`/projects/${projectId}/dashboard/delegate`, {
      entity: item.entity,
      suggestedAction: action,
    })
    const id = `${item.entity.source}-${item.entity.entityId}`
    set((s) => ({
      delegatingItem: null,
      acknowledgedIds: new Set([...s.acknowledgedIds, id]),
    }))
  },

  acknowledge: (entityId) => {
    set((s) => ({ acknowledgedIds: new Set([...s.acknowledgedIds, entityId]) }))
  },
}))
