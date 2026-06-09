import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedAgentWorkspace, destroyTestDb } from '@creare/database/testing'
import { recordCost, getProjectSpend } from './cost-tracking'

let projectId: string
let wsA: string
let wsB: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  wsA = seedAgentWorkspace(projectId, 'A')
  wsB = seedAgentWorkspace(projectId, 'B')
})
afterEach(() => destroyTestDb())

const cost = (agentWorkspaceId: string, costCents: number) =>
  recordCost({
    projectId,
    agentWorkspaceId,
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costCents,
  })

describe('reporting — cost tracking', () => {
  it('sums total spend and breaks it down per workspace', async () => {
    await cost(wsA, 30)
    await cost(wsA, 20)
    await cost(wsB, 15)
    const spend = await getProjectSpend(projectId)
    expect(spend.totalCents).toBe(65)
    expect(spend.byWorkspace[wsA]).toBe(50)
    expect(spend.byWorkspace[wsB]).toBe(15)
  })

  it('honors the since filter', async () => {
    await cost(wsA, 40)
    expect((await getProjectSpend(projectId, '2000-01-01T00:00:00.000Z')).totalCents).toBe(40)
    expect((await getProjectSpend(projectId, '9999-01-01T00:00:00.000Z')).totalCents).toBe(0)
  })
})
