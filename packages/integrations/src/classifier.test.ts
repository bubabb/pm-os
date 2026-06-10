import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, externalEventCache } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'
import { classifyItems } from './index'
import type { NormalizedEntity } from './types'

// Mock the AI SDK so no test ever reaches the network. The rule engine and the
// classification cache must resolve items WITHOUT this mock being called.
const llm = vi.hoisted(() => ({
  complete: vi.fn(async () => ({
    content: JSON.stringify({ bucket: 'agent', urgency: 2, riskType: null, suggestedAction: 'Triage ticket' }),
    inputTokens: 10,
    outputTokens: 5,
    costCents: 1,
    durationMs: 50,
    model: 'test-model',
    provider: 'anthropic' as const,
  })),
}))
vi.mock('@creare/ai-sdk', () => ({ complete: llm.complete }))

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId)
  llm.complete.mockClear()
})
afterEach(() => destroyTestDb())

function entity(overrides: Partial<NormalizedEntity>): NormalizedEntity {
  return {
    source: 'github',
    entityType: 'pr',
    entityId: generateId(),
    entityUrl: null,
    title: 'untitled',
    status: 'open',
    assignee: null,
    updatedAt: null,
    raw: {},
    ...overrides,
  }
}

function seedCacheRow(e: NormalizedEntity, classification?: object) {
  const id = generateId()
  getDb()
    .insert(externalEventCache)
    .values({
      id,
      projectId,
      credentialId,
      source: e.source,
      entityType: e.entityType,
      entityId: e.entityId,
      payload: JSON.stringify(e),
      ...(classification ? { classification: JSON.stringify(classification) } : {}),
    })
    .run()
  return getDb().select().from(externalEventCache).where(eq(externalEventCache.id, id)).all()[0]!
}

const classify = (rows: ReturnType<typeof seedCacheRow>[]) =>
  classifyItems(rows, 'test-key', 'anthropic', 'test-model')

describe('integrations — classifier rule engine (stage 1, no LLM)', () => {
  it('routes budget / sign-off / escalation titles to human at urgency 5', async () => {
    const rows = [
      seedCacheRow(entity({ source: 'jira', entityType: 'ticket', title: 'Q3 budget overrun' })),
      seedCacheRow(entity({ source: 'jira', entityType: 'ticket', title: 'Needs sign-off from legal' })),
      seedCacheRow(entity({ source: 'jira', entityType: 'ticket', title: 'Escalate outage to vendor' })),
    ]
    const items = await classify(rows)
    for (const item of items) {
      expect(item.bucket).toBe('human')
      expect(item.urgency).toBe(5)
      expect(item.riskType).toBe('decision')
    }
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('routes security-labelled items to human with riskType security', async () => {
    const row = seedCacheRow(
      entity({ source: 'jira', entityType: 'ticket', title: 'Patch CVE', raw: { labels: ['security'] } }),
    )
    const [item] = await classify([row])
    expect(item).toMatchObject({ bucket: 'human', urgency: 5, riskType: 'security' })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('routes a non-draft PR with requested reviewers to human', async () => {
    const row = seedCacheRow(
      entity({ entityType: 'pr', title: 'Add caching layer', raw: { isDraft: false, requestedReviewers: 2 } }),
    )
    const [item] = await classify([row])
    expect(item).toMatchObject({ bucket: 'human', urgency: 4, suggestedAction: 'Review pull request' })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('routes an unassigned, unlabelled ticket to agent (triage)', async () => {
    const row = seedCacheRow(
      entity({ source: 'jira', entityType: 'ticket', title: 'Flaky test on CI', assignee: null, raw: { labels: [] } }),
    )
    const [item] = await classify([row])
    expect(item).toMatchObject({ bucket: 'agent', urgency: 2 })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('delegates onedrive files, confluence pages, and notion notes to agent', async () => {
    const rows = [
      seedCacheRow(entity({ source: 'onedrive', entityType: 'file', title: 'Standup notes.docx' })),
      seedCacheRow(entity({ source: 'confluence', entityType: 'page', title: 'API docs' })),
      seedCacheRow(entity({ source: 'notion', entityType: 'note', title: 'Planning meeting' })),
    ]
    const items = await classify(rows)
    expect(items.map((i) => i.bucket)).toEqual(['agent', 'agent', 'agent'])
    expect(llm.complete).not.toHaveBeenCalled()
  })
})

describe('integrations — classifier caching and LLM fallback', () => {
  // An entity no rule matches: labelled AND assigned ticket
  const ambiguous = () =>
    entity({ source: 'jira', entityType: 'ticket', title: 'Refactor auth module', assignee: 'alice', raw: { labels: ['tech-debt'] } })

  it('returns a stored classification without calling the LLM', async () => {
    const row = seedCacheRow(ambiguous(), {
      bucket: 'human',
      urgency: 4,
      riskType: 'decision',
      suggestedAction: 'From cache',
    })
    const [item] = await classify([row])
    expect(item).toMatchObject({ bucket: 'human', urgency: 4, suggestedAction: 'From cache' })
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('classifies ambiguous items via the (mocked) LLM and persists the result on the row', async () => {
    const row = seedCacheRow(ambiguous())
    const [item] = await classify([row])
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(item).toMatchObject({ bucket: 'agent', urgency: 2, suggestedAction: 'Triage ticket' })

    // The result is now persisted — a second pass must not call the LLM again
    const [persisted] = getDb().select().from(externalEventCache).where(eq(externalEventCache.id, row.id)).all()
    expect(persisted?.classification).toBeTruthy()
    expect(persisted?.classifiedAt).toBeTruthy()

    llm.complete.mockClear()
    const [again] = await classify([persisted!])
    expect(again?.bucket).toBe('agent')
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('falls back to human / urgency 3 when the LLM call fails', async () => {
    llm.complete.mockRejectedValueOnce(new Error('provider down'))
    const row = seedCacheRow(ambiguous())
    const [item] = await classify([row])
    expect(item).toMatchObject({ bucket: 'human', urgency: 3, suggestedAction: 'Review manually' })
  })

  it('skips rows with malformed payloads instead of throwing', async () => {
    const good = seedCacheRow(entity({ source: 'onedrive', entityType: 'file', title: 'notes' }))
    const badId = generateId()
    getDb()
      .insert(externalEventCache)
      .values({ id: badId, projectId, credentialId, source: 'jira', entityType: 'ticket', entityId: 'X-1', payload: 'not json{' })
      .run()
    const bad = getDb().select().from(externalEventCache).where(eq(externalEventCache.id, badId)).all()[0]!

    const items = await classify([bad, good])
    expect(items).toHaveLength(1)
    expect(items[0]?.entity.title).toBe('notes')
  })
})
