import { getDb, externalEventCache, integrationSyncState } from '@pm-os/database'
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
import type { ModelProvider } from '@pm-os/ai-sdk'
import type { IntegrationCredential, ExternalEventCache, PmDigestCache } from '@pm-os/database'
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

// ── Bidirectional mirror (GitHub Projects v2, Phase 1) ───────────────────────
// Pull/import surface + durable push outbox. The desktop routes layer resolves
// plaintext tokens via the secrets layer and passes them in — this package
// never decrypts anything.
export { createMirror, pullMirror, getMirrorStatus, listRemoteBoards, resolveRemoteBoard } from './mirror/mirror-sync'
export type { MirrorStatus } from './mirror/mirror-sync'
export {
  enqueueMutation,
  enqueueBoardItemMove,
  enqueueItemCreate,
  enqueueItemUpdate,
  enqueueItemClose,
  enqueueItemComment,
  drainMutationQueue,
  recoverStaleInFlight,
} from './mirror/outbox'
export type { DrainResult } from './mirror/outbox'
// Conflict resolution backend — lists open sync_conflicts in human terms and
// applies the user's verdict (local_wins / remote_wins / dismiss).
export { listOpenConflicts, resolveConflict } from './mirror/conflicts'
export type { ConflictView, ConflictResolution } from './mirror/conflicts'
// The single source→connector construction — routes that need a raw connector
// (rare) build it here instead of importing connector classes.
export { buildConnector } from './sync-engine'
// DEPRECATED escape hatch: superseded by listRemoteBoards(source, config) above,
// kept only until the mirrors route migrates off direct construction.
export { GitHubConnector } from './connectors/github'

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
