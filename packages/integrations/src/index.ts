import { getDb, externalEventCache, integrationSyncState } from '@creare/database'
import { eq, and, isNull, gte, inArray, desc } from 'drizzle-orm'
import { sync } from './sync-engine'
import { GitHubConnector } from './connectors/github'
import { JiraConnector } from './connectors/jira'
import { ConfluenceConnector } from './connectors/confluence'
import { NotionConnector } from './connectors/notion'
import { OneDriveConnector } from './connectors/onedrive'
import { classifyItems as classifyRows } from './classifier'
import { correlateEntities as correlate } from './correlator'
import { generateDigest, getLatestDigest as getCachedDigest } from './digest-generator'
import type { ModelProvider } from '@creare/ai-sdk'
import type { IntegrationCredential, ExternalEventCache, PmDigestCache } from '@creare/database'
import type { ClassifiedItem, ConnectorConfig, IntegrationSource, ResourceOption, SyncStatus } from './types'

export type { IntegrationSource, ClassifiedItem, SyncStatus, NormalizedEntity, ConnectorConfig, ResourceOption } from './types'
export type {
  MutationKind,
  RemoteRef,
  MutationOp,
  MutationEnvelope,
  MutationResult,
  ConnectorCapabilities,
  MirrorColumnSnapshot,
  MirrorItemSnapshot,
  MirrorBoardSnapshot,
  RemoteBoardOption,
} from './types'

// Lists the resources (repos/projects/spaces/databases/folders) the given
// connection token can access — powers the UI resource picker. The connector
// classes stay internal to this package; this helper is the public surface.
export async function listConnectorResources(
  source: IntegrationSource,
  config: ConnectorConfig,
): Promise<ResourceOption[]> {
  switch (source) {
    case 'github':     return new GitHubConnector(config).listResources()
    case 'jira':       return new JiraConnector(config).listResources()
    case 'confluence': return new ConfluenceConnector(config).listResources()
    case 'notion':     return new NotionConnector(config).listResources()
    case 'onedrive':   return new OneDriveConnector(config).listResources()
  }
}

export async function triggerSync(
  projectId: string,
  credentials: Array<{ credential: IntegrationCredential; token: string }>,
  source?: IntegrationSource,
): Promise<void> {
  const targets = source
    ? credentials.filter((c) => c.credential.source === source)
    : credentials

  await Promise.allSettled(targets.map(({ credential, token }) => sync(credential, token)))
}

export async function getSyncStatus(projectId: string): Promise<SyncStatus[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(integrationSyncState)
    .where(eq(integrationSyncState.projectId, projectId))

  return rows.map((r) => ({
    credentialId: r.credentialId,
    source: r.source as IntegrationSource,
    status: r.status,
    lastSyncedAt: r.lastSyncedAt,
    lastErrorMessage: r.lastErrorMessage,
  }))
}

export async function getActiveEvents(
  projectId: string,
  filters?: {
    sources?: IntegrationSource[]
    entityTypes?: string[]
    since?: string
  },
): Promise<ExternalEventCache[]> {
  const db = getDb()
  const conditions = [
    eq(externalEventCache.projectId, projectId),
    isNull(externalEventCache.purgedAt),
  ]

  if (filters?.since) {
    conditions.push(gte(externalEventCache.fetchedAt, filters.since))
  }
  if (filters?.sources?.length) {
    conditions.push(inArray(externalEventCache.source, filters.sources))
  }
  if (filters?.entityTypes?.length) {
    conditions.push(inArray(externalEventCache.entityType, filters.entityTypes))
  }

  return db
    .select()
    .from(externalEventCache)
    .where(and(...conditions))
    .orderBy(desc(externalEventCache.fetchedAt))
    .limit(200)
}

export async function correlateEntities(
  entityId: string,
  source: IntegrationSource,
  projectId: string,
): Promise<ExternalEventCache[]> {
  return correlate(entityId, source, projectId)
}

export async function classifyItems(
  rows: ExternalEventCache[],
  apiKey: string,
  provider: ModelProvider,
  model: string,
): Promise<ClassifiedItem[]> {
  return classifyRows(rows, apiKey, provider, model)
}

export async function generatePmDigest(
  projectId: string,
  digestType: PmDigestCache['digestType'],
  items: ClassifiedItem[],
  apiKey: string,
  provider: ModelProvider,
  model: string,
): Promise<PmDigestCache> {
  return generateDigest(projectId, digestType, items, apiKey, provider, model)
}

export async function getLatestDigest(
  projectId: string,
  digestType: PmDigestCache['digestType'],
): Promise<PmDigestCache | null> {
  return getCachedDigest(projectId, digestType)
}
