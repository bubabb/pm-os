import { getDb, integrationCredentials } from '@creare/database'
import { count, eq } from 'drizzle-orm'
import { getActiveEvents, classifyItems, getLatestDigest, getSyncStatus } from '@creare/integrations'
import { getSprintContext } from './sprint-reader'
import { getAgentActivity } from './agent-activity'
import { llmAvailable } from '@creare/ai-sdk'
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
  /** Kept for backward compatibility — true when the project has at least one connected source. */
  hasIntegrations: boolean
  integrations: IntegrationsSummary
}

// Distinguishes the three onboarding states the UI renders:
//   connectedCount === 0                          → no sources connected ("Connect your tools")
//   connectedCount > 0 && syncedItemCount === 0   → connected but nothing synced yet (show Sync)
//   syncedItemCount > 0                           → has data (full dashboard)
export interface IntegrationsSummary {
  connectedCount: number
  syncedItemCount: number
  lastSyncedAt: string | null
}

export async function getDashboard(
  projectId: string,
  apiKey: string | null,
  provider: ModelProvider,
  model: string,
): Promise<DashboardResponse> {
  const [sprintContext, agentActivity, activeEvents, syncStates, connectedCount] = await Promise.all([
    getSprintContext(projectId),
    getAgentActivity(projectId),
    getActiveEvents(projectId),
    getSyncStatus(projectId),
    countConnectedSources(projectId),
  ])

  // "Connected" means a source credential exists — NOT that the event cache has
  // rows. A freshly connected source has connectedCount > 0 but zero synced items.
  const hasIntegrations = connectedCount > 0

  const integrations: IntegrationsSummary = {
    connectedCount,
    syncedItemCount: activeEvents.length,
    // ISO-8601 timestamps compare correctly as strings — take the most recent.
    lastSyncedAt: syncStates.reduce<string | null>(
      (max, s) => (s.lastSyncedAt !== null && (max === null || s.lastSyncedAt > max) ? s.lastSyncedAt : max),
      null,
    ),
  }

  let classified: DashboardResponse['classified'] = { doNow: [], delegate: [], risks: [] }

  // claude-cli has no key but is still callable via the membership login, so gate on
  // llmAvailable() rather than the key's truthiness.
  if (activeEvents.length > 0 && llmAvailable(provider, apiKey)) {
    const items = await classifyItems(activeEvents, apiKey ?? '', provider, model)
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
    integrations,
  }
}

// Number of integration_credentials (sources) bound to the project. A credential
// row IS the connection — it exists as soon as the user connects a tool, before
// any sync has populated the event cache.
async function countConnectedSources(projectId: string): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ value: count() })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.projectId, projectId))
  return row?.value ?? 0
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
