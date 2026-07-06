import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@pm-os/database/testing'
import { getDb, externalEventCache } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { correlateEntities } from './index'
import type { NormalizedEntity } from './types'

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId)
})
afterEach(() => destroyTestDb())

function seedEntity(e: Partial<NormalizedEntity> & Pick<NormalizedEntity, 'source' | 'entityType' | 'entityId'>, purged = false) {
  const full: NormalizedEntity = {
    entityUrl: null,
    title: 'untitled',
    status: 'open',
    assignee: null,
    updatedAt: null,
    raw: {},
    ...e,
  }
  getDb()
    .insert(externalEventCache)
    .values({
      id: generateId(),
      projectId,
      credentialId,
      source: full.source,
      entityType: full.entityType,
      entityId: full.entityId,
      payload: JSON.stringify(full),
      purgedAt: purged ? new Date().toISOString() : null,
    })
    .run()
}

describe('integrations — correlator (Jira ↔ GitHub)', () => {
  it('finds the Jira tickets referenced by a GitHub PR', async () => {
    seedEntity({ source: 'github', entityType: 'pr', entityId: '42', raw: { ticketIds: ['PROJ-7', 'PROJ-9'] } })
    seedEntity({ source: 'jira', entityType: 'ticket', entityId: 'PROJ-7' })
    seedEntity({ source: 'jira', entityType: 'ticket', entityId: 'PROJ-9' })
    seedEntity({ source: 'jira', entityType: 'ticket', entityId: 'PROJ-99' }) // unrelated

    const matches = await correlateEntities('42', 'github', projectId)
    expect(matches.map((m) => m.entityId).sort()).toEqual(['PROJ-7', 'PROJ-9'])
  })

  it('finds the GitHub PRs that reference a Jira ticket', async () => {
    seedEntity({ source: 'github', entityType: 'pr', entityId: '1', raw: { ticketIds: ['PROJ-7'] } })
    seedEntity({ source: 'github', entityType: 'pr', entityId: '2', raw: { ticketIds: ['OTHER-1'] } })
    seedEntity({ source: 'jira', entityType: 'ticket', entityId: 'PROJ-7' })

    const matches = await correlateEntities('PROJ-7', 'jira', projectId)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.entityId).toBe('1')
  })

  it('never returns a false positive from a substring-only payload match', async () => {
    // Payload contains the literal string "PROJ-7" (in the title) but ticketIds does NOT
    seedEntity({
      source: 'github', entityType: 'pr', entityId: '3',
      title: 'Mentions "PROJ-7" in prose only', raw: { ticketIds: [] },
    })

    expect(await correlateEntities('PROJ-7', 'jira', projectId)).toHaveLength(0)
  })

  it('returns [] for purged rows, unknown entities, and non-correlatable sources', async () => {
    seedEntity({ source: 'github', entityType: 'pr', entityId: '5', raw: { ticketIds: ['PROJ-1'] } }, true) // purged
    seedEntity({ source: 'jira', entityType: 'ticket', entityId: 'PROJ-1' })

    expect(await correlateEntities('5', 'github', projectId)).toHaveLength(0)   // purged PR
    expect(await correlateEntities('999', 'github', projectId)).toHaveLength(0) // not in cache
    expect(await correlateEntities('page-1', 'confluence', projectId)).toHaveLength(0) // unsupported source
  })
})
