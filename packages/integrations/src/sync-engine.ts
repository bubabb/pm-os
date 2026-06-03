import { getDb, externalEventCache, integrationSyncState, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and, isNull } from 'drizzle-orm'
import { GitHubConnector } from './connectors/github'
import { JiraConnector } from './connectors/jira'
import { ConfluenceConnector } from './connectors/confluence'
import { NotionConnector } from './connectors/notion'
import { OneDriveConnector } from './connectors/onedrive'
import { toExternalEventCacheRow } from './normalizer'
import type { BaseConnector } from './connectors/base'
import type { IntegrationCredential } from '@creare/database'
import type { ConnectorConfig, IntegrationSource } from './types'

function buildConnector(
  source: IntegrationSource,
  config: ConnectorConfig,
): BaseConnector {
  switch (source) {
    case 'github':    return new GitHubConnector(config)
    case 'jira':      return new JiraConnector(config)
    case 'confluence': return new ConfluenceConnector(config)
    case 'notion':    return new NotionConnector(config)
    case 'onedrive':  return new OneDriveConnector(config)
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

  // Upsert sync state to 'syncing'
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
      target: [integrationSyncState.credentialId],
      set: { status: 'syncing', lastErrorMessage: null, updatedAt: new Date().toISOString() },
    })

  // Write sync.started event
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

    // Soft-purge stale rows for this credential before writing fresh ones
    await db
      .update(externalEventCache)
      .set({ purgedAt: new Date().toISOString() })
      .where(
        and(
          eq(externalEventCache.credentialId, credentialId),
          isNull(externalEventCache.purgedAt),
        ),
      )

    // Fetch all pages
    let cursor: string | undefined
    let totalFetched = 0

    do {
      const { entities, nextCursor } = await connector.fetchEntities(cursor)
      if (entities.length > 0) {
        const rows = entities.map((e) => toExternalEventCacheRow(e, credentialId, projectId))
        await db.insert(externalEventCache).values(rows)
        totalFetched += entities.length
      }
      cursor = nextCursor ?? undefined
    } while (cursor)

    // Update sync state to idle
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

    // Write sync.completed event
    await db.insert(events).values({
      id: generateId(),
      type: 'integration.sync.completed',
      domain: 'integrations',
      projectId,
      actorType: 'system',
      actorId: null,
      resourceType: 'integration_credential',
      resourceId: credentialId,
      payload: JSON.stringify({ credentialId, source, projectId, itemsFetched: totalFetched }),
    })

    return { itemsFetched: totalFetched }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)

    await db
      .update(integrationSyncState)
      .set({
        status: 'error',
        lastErrorMessage: errorMessage,
        updatedAt: new Date().toISOString(),
      })
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
