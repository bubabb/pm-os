import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedAgentWorkspace, seedTask, destroyTestDb } from '@pm-os/database/testing'
import { getDb, traces } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
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
  completedAt?: string | null
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
      ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {}),
    })
    .run()
  return id
}

describe('reporting — agent activity', () => {
  it('partitions traces into running / completedToday / failed', async () => {
    const runningId = seedTrace({ status: 'running' })
    // Started yesterday, completed today — must count via completedAt (regression
    // coverage for the bug where the filter checked startedAt instead of completedAt).
    const todayId = seedTrace({
      status: 'completed',
      startedAt: '2020-01-01T08:00:00.000Z',
      completedAt: new Date().toISOString(),
    })
    // Completed today but completedAt was never stamped (a valid updateTrace pattern) —
    // must still count via the startedAt fallback, not silently vanish.
    const nullTodayId = seedTrace({ status: 'completed', startedAt: new Date().toISOString(), completedAt: null })
    seedTrace({
      status: 'completed',
      startedAt: '2020-01-01T08:00:00.000Z',
      completedAt: '2020-01-01T09:00:00.000Z',
    }) // old — excluded
    seedTrace({ status: 'completed', startedAt: '2020-01-01T08:00:00.000Z', completedAt: null }) // old, no completedAt — excluded via fallback
    const failedId = seedTrace({ status: 'failed' })

    const activity = await getAgentActivity(projectId)
    expect(activity.running.map((t) => t.id)).toEqual([runningId])
    expect(activity.completedToday.map((t) => t.id).sort()).toEqual([todayId, nullTodayId].sort())
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
