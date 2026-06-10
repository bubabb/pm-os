import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, externalEventCache, integrationCredentials } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, isNotNull, and } from 'drizzle-orm'
import { triggerSync, getSyncStatus, getActiveEvents } from './index'
import type { IntegrationCredential } from '@creare/database'
import type { NormalizedEntity } from './types'

// Replace the GitHub connector with a controllable stub — sync() must never hit
// the network in tests. extractTicketIds is re-exported because the correlator
// (loaded via ./index) imports it from the same module.
const stub = vi.hoisted(() => ({
  entities: [] as unknown[],
  error: null as Error | null,
}))
vi.mock('./connectors/github', () => ({
  extractTicketIds: (text: string) => [...text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1]!),
  GitHubConnector: class {
    constructor(_config: unknown) {}
    async fetchEntities(_cursor?: string) {
      if (stub.error) throw stub.error
      return { entities: stub.entities, nextCursor: null }
    }
  },
}))

let projectId: string
let credential: IntegrationCredential

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  const credentialId = seedCredential(projectId, 'github')
  credential = getDb()
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId))
    .all()[0]!
  stub.entities = []
  stub.error = null
})
afterEach(() => destroyTestDb())

function fetchedEntity(entityId: string): NormalizedEntity {
  return {
    source: 'github', entityType: 'pr', entityId, entityUrl: null,
    title: `PR ${entityId}`, status: 'open', assignee: null, updatedAt: null, raw: {},
  }
}

function seedExistingCacheRow(entityId: string) {
  getDb()
    .insert(externalEventCache)
    .values({
      id: generateId(), projectId, credentialId: credential.id,
      source: 'github', entityType: 'pr', entityId, payload: '{}',
    })
    .run()
}

const runSync = () => triggerSync(projectId, [{ credential, token: 'tok' }], 'github')

describe('integrations — sync engine', () => {
  it('does NOT purge existing cache rows when a sync fetches zero entities', async () => {
    seedExistingCacheRow('keep-me')
    stub.entities = []

    await runSync()

    const active = await getActiveEvents(projectId)
    expect(active.map((r) => r.entityId)).toEqual(['keep-me']) // last good data preserved
    const [status] = await getSyncStatus(projectId)
    expect(status?.status).toBe('idle')
    expect(status?.lastSyncedAt).toBeTruthy()
  })

  it('purges stale rows and inserts fresh ones in one pass on a successful fetch', async () => {
    seedExistingCacheRow('stale')
    stub.entities = [fetchedEntity('fresh-1'), fetchedEntity('fresh-2')]

    await runSync()

    const active = await getActiveEvents(projectId)
    expect(active.map((r) => r.entityId).sort()).toEqual(['fresh-1', 'fresh-2'])

    // The superseded row is soft-purged, not deleted — append-only cache
    const purged = getDb()
      .select()
      .from(externalEventCache)
      .where(and(eq(externalEventCache.entityId, 'stale'), isNotNull(externalEventCache.purgedAt)))
      .all()
    expect(purged).toHaveLength(1)
  })

  it('marks sync state as error with the failure message when the connector throws', async () => {
    seedExistingCacheRow('keep-me')
    stub.error = new Error('401 bad credentials')

    await runSync() // triggerSync uses allSettled — must not reject

    const [status] = await getSyncStatus(projectId)
    expect(status?.status).toBe('error')
    expect(status?.lastErrorMessage).toBe('401 bad credentials')
    // Cache untouched on failure
    expect((await getActiveEvents(projectId)).map((r) => r.entityId)).toEqual(['keep-me'])
  })
})
