import { getDb, externalEventCache, integrationSyncState, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and, isNull, lt } from 'drizzle-orm'
import { GitHubConnector } from './connectors/github'
import { JiraConnector } from './connectors/jira'
import { ConfluenceConnector } from './connectors/confluence'
import { NotionConnector } from './connectors/notion'
import { OneDriveConnector } from './connectors/onedrive'
import { toExternalEventCacheRow } from './normalizer'
import type { BaseConnector } from './connectors/base'
import type { IntegrationCredential } from '@creare/database'
import type { ConnectorConfig, IntegrationSource, NormalizedEntity } from './types'

const MAX_ITEMS_PER_SYNC = 500
const PURGED_ROW_RETENTION_MS = 7 * 24 * 3600 * 1000 // hard-delete soft-purged rows after 7 days

// The single source→connector construction, shared by the read-side sync (here),
// the board mirror (mirror/mirror-sync.ts), and the routes layer (via index.ts).
export function buildConnector(source: IntegrationSource, config: ConnectorConfig): BaseConnector {
  switch (source) {
    case 'github':     return new GitHubConnector(config)
    case 'jira':       return new JiraConnector(config)
    case 'confluence': return new ConfluenceConnector(config)
    case 'notion':     return new NotionConnector(config)
    case 'onedrive':   return new OneDriveConnector(config)
  }
}

export async function sync(
  credential: IntegrationCredential,
  token: string,
): Promise<{ itemsFetched: number }> {
  const db = getDb()
  const { id: credentialId, projectId, source } = credential

  const metadata = (() => {
    try { return JSON.parse(credential.metadata) as Record<string, unknown> }
    catch { return {} }
  })()

  // Upsert sync state — unique constraint on credentialId ensures one row per credential
  await db
    .insert(integrationSyncState)
    .values({
      id: generateId(),
      projectId,
      credentialId,
      source,
      status: 'syncing',
      lastSyncedAt: null,
      syncCursor: null,
      lastErrorMessage: null,
    })
    .onConflictDoUpdate({
      target: integrationSyncState.credentialId,
      set: { status: 'syncing', lastErrorMessage: null, updatedAt: new Date().toISOString() },
    })

  await db.insert(events).values({
    id: generateId(),
    type: 'integration.sync.started',
    domain: 'integrations',
    projectId,
    actorType: 'system',
    actorId: null,
    resourceType: 'integration_credential',
    resourceId: credentialId,
    payload: JSON.stringify({ credentialId, source, projectId }),
  })

  const rawBaseUrl = metadata['baseUrl'] as string | undefined
  const config: ConnectorConfig = {
    credentialId,
    projectId,
    token,
    ...(rawBaseUrl !== undefined ? { baseUrl: rawBaseUrl } : {}),
    metadata,
  }

  try {
    const connector = buildConnector(source as IntegrationSource, config)

    // Fetch ALL pages into memory before touching the cache — atomic purge+insert below
    const allEntities: NormalizedEntity[] = []
    let cursor: string | undefined

    do {
      const { entities, nextCursor } = await connector.fetchEntities(cursor)
      allEntities.push(...entities)
      cursor = nextCursor ?? undefined
      // Hard cap to prevent unbounded memory use on large repos
      if (allEntities.length >= MAX_ITEMS_PER_SYNC) break
    } while (cursor)

    // Now atomically: purge stale rows, then bulk-insert fresh ones — a single
    // synchronous transaction so there is no window where the cache is empty.
    // If the fetch came back empty (transient failure, revoked scope, empty 403
    // body, etc.), SKIP the purge entirely — keep showing the last good data
    // rather than blanking the dashboard.
    if (allEntities.length > 0) {
      const rows = allEntities.map((e) => toExternalEventCacheRow(e, credentialId, projectId))
      db.transaction((tx) => {
        tx.update(externalEventCache)
          .set({ purgedAt: new Date().toISOString() })
          .where(and(
            eq(externalEventCache.credentialId, credentialId),
            isNull(externalEventCache.purgedAt),
          ))
          .run()
        tx.insert(externalEventCache).values(rows).run()
      })

      // Retention: hard-delete rows soft-purged more than 7 days ago to bound growth
      const retentionCutoff = new Date(Date.now() - PURGED_ROW_RETENTION_MS).toISOString()
      await db
        .delete(externalEventCache)
        .where(lt(externalEventCache.purgedAt, retentionCutoff))
    }

    await db
      .update(integrationSyncState)
      .set({
        status: 'idle',
        lastSyncedAt: new Date().toISOString(),
        syncCursor: null,
        lastErrorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(integrationSyncState.credentialId, credentialId))

    await db.insert(events).values({
      id: generateId(),
      type: 'integration.sync.completed',
      domain: 'integrations',
      projectId,
      actorType: 'system',
      actorId: null,
      resourceType: 'integration_credential',
      resourceId: credentialId,
      payload: JSON.stringify({ credentialId, source, projectId, itemsFetched: allEntities.length }),
    })

    return { itemsFetched: allEntities.length }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    await db
      .update(integrationSyncState)
      .set({ status: 'error', lastErrorMessage: errorMessage, updatedAt: new Date().toISOString() })
      .where(eq(integrationSyncState.credentialId, credentialId))

    await db.insert(events).values({
      id: generateId(),
      type: 'integration.sync.failed',
      domain: 'integrations',
      projectId,
      actorType: 'system',
      actorId: null,
      resourceType: 'integration_credential',
      resourceId: credentialId,
      payload: JSON.stringify({ credentialId, source, projectId, error: errorMessage }),
    })

    throw err
  }
}
