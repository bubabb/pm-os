import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import { getDb, externalEventCache, pmDigestCache } from '@creare/database'
import { generateId } from '@creare/shared'
import { getDashboard } from './index'

// The dashboard classifies cache rows via @creare/integrations, which calls the
// LLM for ambiguous items — mock the AI SDK so tests are deterministic + offline.
const llm = vi.hoisted(() => ({
  complete: vi.fn(async () => ({
    content: JSON.stringify({ bucket: 'agent', urgency: 1, riskType: null, suggestedAction: 'Watch' }),
    inputTokens: 10,
    outputTokens: 5,
    costCents: 1,
    durationMs: 50,
    model: 'test-model',
    provider: 'anthropic' as const,
  })),
}))
vi.mock('@creare/ai-sdk', () => ({
  complete: llm.complete,
  // Keep in sync with the real ai-sdk helpers: keyed providers need a non-empty key;
  // claude-cli is always callable via the membership login.
  llmAvailable: (provider: string, apiKey: string | null) =>
    provider === 'claude-cli' ? true : !!apiKey,
}))

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId)
  llm.complete.mockClear()
})
afterEach(() => destroyTestDb())

function seedCacheRow(source: string, entityType: string, title: string, raw: Record<string, unknown> = {}) {
  const entityId = generateId()
  getDb()
    .insert(externalEventCache)
    .values({
      id: generateId(), projectId, credentialId,
      source: source as 'github' | 'jira', entityType, entityId,
      payload: JSON.stringify({
        source, entityType, entityId, entityUrl: null,
        title, status: 'open', assignee: null, updatedAt: null, raw,
      }),
    })
    .run()
}

const dashboard = (apiKey: string | null = 'test-key') =>
  getDashboard(projectId, apiKey, 'anthropic', 'test-model')

describe('reporting — PM command center dashboard', () => {
  it('reports connected-but-unsynced and an empty, stale dashboard for a fresh project', async () => {
    const d = await dashboard()
    // A credential is bound (seedCredential in beforeEach) but nothing has synced:
    // the connected-but-empty state, distinct from "no integrations".
    expect(d.hasIntegrations).toBe(true)
    expect(d.integrations.connectedCount).toBeGreaterThan(0)
    expect(d.integrations.syncedItemCount).toBe(0)
    expect(d.integrations.lastSyncedAt).toBeNull()
    expect(d.classified).toEqual({ doNow: [], delegate: [], risks: [] })
    expect(d.digest).toEqual({ morningBrief: null, isStale: true, generatedAt: null })
    expect(d.sprintContext.activeSprint).toBeNull()
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('partitions classified items into doNow / delegate / risks, sorted by urgency', async () => {
    seedCacheRow('jira', 'ticket', 'Approve Q3 budget')                                 // human, urgency 5, risk: decision
    seedCacheRow('jira', 'ticket', 'Architect review for payments service')            // human, urgency 4, risk: decision
    seedCacheRow('confluence', 'page', 'Team handbook')                                 // agent, urgency 1
    seedCacheRow('onedrive', 'file', 'Sprint retro notes.docx')                         // agent, urgency 2

    const d = await dashboard()
    expect(d.hasIntegrations).toBe(true)
    expect(d.classified.doNow.map((i) => i.entity.title)).toEqual([
      'Approve Q3 budget',
      'Architect review for payments service',
    ])
    expect(d.classified.delegate.map((i) => i.entity.title)).toEqual([
      'Sprint retro notes.docx', // urgency 2 sorts before 1
      'Team handbook',
    ])
    expect(d.classified.risks.map((i) => i.riskType)).toEqual(['decision', 'decision'])
    expect(llm.complete).not.toHaveBeenCalled() // all four resolved by the rule engine
  })

  it('skips classification entirely when no API key is configured', async () => {
    seedCacheRow('jira', 'ticket', 'Approve Q3 budget')
    const d = await dashboard(null)
    expect(d.hasIntegrations).toBe(true) // events are still visible…
    expect(d.classified).toEqual({ doNow: [], delegate: [], risks: [] }) // …but never classified
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('surfaces a fresh cached morning brief and flags an expired one as stale', async () => {
    const seedDigest = (validUntil: string, summary: string) =>
      getDb().insert(pmDigestCache).values({
        id: generateId(), projectId, digestType: 'morning_brief',
        content: JSON.stringify({ summary, doNow: [], delegate: [] }),
        generatedAt: new Date().toISOString(), validUntil,
      }).run()

    // Expired digest only → stale, and getLatestDigest filters it out entirely
    seedDigest('2000-01-01T00:00:00.000Z', 'old brief')
    let d = await dashboard()
    expect(d.digest.isStale).toBe(true)
    expect(d.digest.morningBrief).toBeNull()

    // Valid digest → summary extracted from the JSON content
    seedDigest('9999-01-01T00:00:00.000Z', 'all quiet on the western front')
    d = await dashboard()
    expect(d.digest.isStale).toBe(false)
    expect(d.digest.morningBrief).toBe('all quiet on the western front')
    expect(d.digest.generatedAt).toBeTruthy()
  })
})
