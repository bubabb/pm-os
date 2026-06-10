import { getActiveEvents, classifyItems, getLatestDigest } from '@creare/integrations'
import { getSprintContext } from './sprint-reader'
import { getAgentActivity } from './agent-activity'
import type { ModelProvider } from '@creare/ai-sdk'
import type { ClassifiedItem } from '@creare/integrations'
import type { SprintContext } from './sprint-reader'
import type { TraceStub } from './agent-activity'

export interface DashboardResponse {
  sprintContext: SprintContext
  classified: {
    doNow: ClassifiedItem[]
    delegate: ClassifiedItem[]
    risks: ClassifiedItem[]
  }
  agentActivity: {
    running: TraceStub[]
    completedToday: TraceStub[]
    failed: TraceStub[]
  }
  digest: {
    morningBrief: string | null
    isStale: boolean
    generatedAt: string | null
  }
  hasIntegrations: boolean
}

export async function getDashboard(
  projectId: string,
  apiKey: string | null,
  provider: ModelProvider,
  model: string,
): Promise<DashboardResponse> {
  const [sprintContext, agentActivity, activeEvents] = await Promise.all([
    getSprintContext(projectId),
    getAgentActivity(projectId),
    getActiveEvents(projectId),
  ])

  const hasIntegrations = activeEvents.length > 0

  let classified: DashboardResponse['classified'] = { doNow: [], delegate: [], risks: [] }

  if (hasIntegrations && apiKey) {
    const items = await classifyItems(activeEvents, apiKey, provider, model)
    classified = partitionItems(items)
  }

  // Load cached morning brief digest
  const cachedDigest = await getLatestDigest(projectId, 'morning_brief')
  const now = new Date().toISOString()
  const isStale = !cachedDigest || cachedDigest.validUntil < now

  return {
    sprintContext,
    classified,
    agentActivity,
    digest: {
      morningBrief: cachedDigest ? tryParseDigest(cachedDigest.content) : null,
      isStale,
      generatedAt: cachedDigest?.generatedAt ?? null,
    },
    hasIntegrations,
  }
}

function partitionItems(items: ClassifiedItem[]): DashboardResponse['classified'] {
  const byUrgencyDesc = (a: ClassifiedItem, b: ClassifiedItem) => b.urgency - a.urgency

  const doNow    = items.filter((i) => i.bucket === 'human').sort(byUrgencyDesc)
  const delegate = items.filter((i) => i.bucket === 'agent').sort(byUrgencyDesc)
  const risks    = items.filter((i) => i.riskType !== null).sort(byUrgencyDesc)

  return { doNow, delegate, risks }
}

function tryParseDigest(content: string): string {
  // Content is JSON — extract summary field for UI display, fall back to raw
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return (parsed['summary'] as string) ?? content
  } catch {
    return content
  }
}
