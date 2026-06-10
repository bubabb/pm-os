import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedAgentWorkspace, seedTask, destroyTestDb } from '@creare/database/testing'
import { getDb, traces } from '@creare/database'
import { generateId } from '@creare/shared'
import { getAgentActivity } from './agent-activity'

let projectId: string
let workspaceId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  workspaceId = seedAgentWorkspace(projectId, 'Builder Agent')
})
afterEach(() => destroyTestDb())

function seedTrace(opts: {
  status: 'running' | 'completed' | 'failed'
  startedAt?: string
  taskId?: string
  costCents?: number
}) {
  const id = generateId()
  getDb()
    .insert(traces)
    .values({
      id,
      projectId,
      agentWorkspaceId: workspaceId,
      taskId: opts.taskId ?? null,
      status: opts.status,
      costCents: opts.costCents ?? 0,
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    })
    .run()
  return id
}

describe('reporting — agent activity', () => {
  it('partitions traces into running / completedToday / failed', async () => {
    const runningId = seedTrace({ status: 'running' })
    const todayId = seedTrace({ status: 'completed' }) // startedAt defaults to now
    seedTrace({ status: 'completed', startedAt: '2020-01-01T08:00:00.000Z' }) // old — excluded
    const failedId = seedTrace({ status: 'failed' })

    const activity = await getAgentActivity(projectId)
    expect(activity.running.map((t) => t.id)).toEqual([runningId])
    expect(activity.completedToday.map((t) => t.id)).toEqual([todayId])
    expect(activity.failed.map((t) => t.id)).toEqual([failedId])
  })

  it('resolves workspace names and task titles onto trace stubs', async () => {
    const taskId = seedTask(projectId, 'Ship the feature')
    seedTrace({ status: 'running', taskId, costCents: 12 })
    seedTrace({ status: 'running' }) // no task

    const { running } = await getAgentActivity(projectId)
    expect(running).toHaveLength(2)
    const withTask = running.find((t) => t.taskTitle !== null)!
    expect(withTask.taskTitle).toBe('Ship the feature')
    expect(withTask.agentWorkspaceName).toBe('Builder Agent')
    expect(withTask.costCents).toBe(12)
    expect(running.find((t) => t.taskTitle === null)?.agentWorkspaceName).toBe('Builder Agent')
  })
})
