import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, externalEventCache, integrationSyncState } from '@creare/database'
import { generateId } from '@creare/shared'
import { getActiveEvents, getSyncStatus } from './index'

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId)
})
afterEach(() => destroyTestDb())

function cacheRow(source: string, entityType: string, entityId: string, purged = false, fetchedAt?: string) {
  getDb()
    .insert(externalEventCache)
    .values({
      id: generateId(),
      projectId,
      credentialId,
      source: source as 'github' | 'jira',
      entityType,
      entityId,
      purgedAt: purged ? new Date().toISOString() : null,
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
    })
    .run()
}

describe('integrations — getActiveEvents', () => {
  it('excludes purged rows and filters by source / entityType', async () => {
    cacheRow('github', 'pr', '1')
    cacheRow('jira', 'ticket', 'PROJ-1')
    cacheRow('github', 'pr', '2', true) // purged → excluded

    expect(await getActiveEvents(projectId)).toHaveLength(2)
    expect(await getActiveEvents(projectId, { sources: ['jira'] })).toHaveLength(1)
    expect(await getActiveEvents(projectId, { entityTypes: ['pr'] })).toHaveLength(1)
  })

  it('returns the most recently fetched rows first', async () => {
    cacheRow('github', 'pr', 'old', false, '2026-06-01T00:00:00.000Z')
    cacheRow('github', 'pr', 'new', false, '2026-06-09T00:00:00.000Z')
    cacheRow('github', 'pr', 'mid', false, '2026-06-05T00:00:00.000Z')

    const rows = await getActiveEvents(projectId)
    expect(rows.map((r) => r.entityId)).toEqual(['new', 'mid', 'old'])
  })
})

describe('integrations — getSyncStatus', () => {
  it('maps sync-state rows to status records', async () => {
    getDb()
      .insert(integrationSyncState)
      .values({ id: generateId(), projectId, credentialId, source: 'github', status: 'idle', lastSyncedAt: '2026-06-01T00:00:00.000Z' })
      .run()

    const status = await getSyncStatus(projectId)
    expect(status).toHaveLength(1)
    expect(status[0]?.credentialId).toBe(credentialId)
    expect(status[0]?.source).toBe('github')
    expect(status[0]?.lastSyncedAt).toBe('2026-06-01T00:00:00.000Z')
  })
})
