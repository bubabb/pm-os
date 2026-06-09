import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedAgentWorkspace, destroyTestDb } from '@creare/database/testing'
import { createTask } from '@creare/agent-orchestration'
import {
  createTrace, getTrace, updateTrace, listTraces,
  addTraceEvent, listTraceEvents,
  addAuditEntry, listAuditLog, listEventLog,
} from './index'

let userId: string
let projectId: string
let workspaceId: string

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
  workspaceId = seedAgentWorkspace(projectId)
})
afterEach(() => destroyTestDb())

describe('observability — traces', () => {
  it('creates, reads, updates, and lists traces', () => {
    const trace = createTrace({ agentWorkspaceId: workspaceId, projectId })
    expect(getTrace(trace.id)?.id).toBe(trace.id)
    updateTrace(trace.id, { status: 'completed' })
    expect(getTrace(trace.id)?.status).toBe('completed')
    expect(listTraces(projectId).map((t) => t.id)).toContain(trace.id)
  })

  it('assigns monotonically increasing sequence numbers to trace events', () => {
    const trace = createTrace({ agentWorkspaceId: workspaceId, projectId })
    addTraceEvent(trace.id, { type: 'llm_call' })
    addTraceEvent(trace.id, { type: 'tool_call' })
    addTraceEvent(trace.id, { type: 'tool_result' })
    const seqs = listTraceEvents(trace.id).map((e) => e.sequenceNumber)
    expect(seqs).toEqual([0, 1, 2])
  })
})

describe('observability — audit log', () => {
  it('records and lists audit entries, filtered by resource', () => {
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'secret.accessed', resourceType: 'secret', resourceId: 's1' })
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'task.approved', resourceType: 'task', resourceId: 't1' })
    expect(listAuditLog(projectId)).toHaveLength(2)
    expect(listAuditLog(projectId, { resourceType: 'secret' })).toHaveLength(1)
  })
})

describe('observability — event log', () => {
  it('surfaces append-only events written by other domains', () => {
    createTask(projectId, { title: 'x', type: 'human' }, userId) // emits task.created
    const events = listEventLog(projectId, { type: 'task.created' })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.type).toBe('task.created')
  })
})
