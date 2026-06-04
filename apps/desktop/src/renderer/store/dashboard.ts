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
  isLoading: false,
  isRefreshing: false,
  error: null,
  delegatingItem: null,
  acknowledgedIds: new Set(),

  load: async (projectId) => {
    set({ isLoading: true, error: null })
    try {
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load dashboard', isLoading: false })
    }
  },

  refresh: async (projectId) => {
    set({ isRefreshing: true })
    try {
      await api.post(`/projects/${projectId}/integrations/sync`, {})
      const data = await api.get<DashboardData>(`/projects/${projectId}/dashboard`)
      set({ data, isRefreshing: false })
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
