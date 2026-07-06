import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedAgentWorkspace, destroyTestDb } from '@pm-os/database/testing'
import { generateId } from '@pm-os/shared'
import { createTask } from '@pm-os/agent-orchestration'
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

  it('numbers each trace independently — interleaved events never share a counter', () => {
    const a = createTrace({ agentWorkspaceId: workspaceId, projectId })
    const b = createTrace({ agentWorkspaceId: workspaceId, projectId })
    addTraceEvent(a.id, { type: 'llm_call' })
    addTraceEvent(b.id, { type: 'llm_call' })
    addTraceEvent(a.id, { type: 'tool_call' })
    expect(listTraceEvents(a.id).map((e) => e.sequenceNumber)).toEqual([0, 1])
    expect(listTraceEvents(b.id).map((e) => e.sequenceNumber)).toEqual([0])
  })

  it('updateTrace patches only the provided fields and leaves the rest intact', () => {
    const trace = createTrace({ agentWorkspaceId: workspaceId, projectId })
    updateTrace(trace.id, { inputTokens: 100, costCents: 7 })
    const after = getTrace(trace.id)!
    expect(after.inputTokens).toBe(100)
    expect(after.costCents).toBe(7)
    expect(after.status).toBe('running')     // untouched
    expect(after.completedAt).toBeNull()     // untouched
    expect(updateTrace('no-such-trace', { status: 'failed' })).toBeNull()
  })

  it('listTraces filters by status and joins the workspace name', () => {
    const running = createTrace({ agentWorkspaceId: workspaceId, projectId })
    const done = createTrace({ agentWorkspaceId: workspaceId, projectId })
    updateTrace(done.id, { status: 'completed' })

    const completed = listTraces(projectId, { status: 'completed' })
    expect(completed.map((t) => t.id)).toEqual([done.id])
    expect(completed[0]?.workspaceName).toBe('Test Agent')
    expect(listTraces(projectId, { status: 'running' }).map((t) => t.id)).toEqual([running.id])
  })

  it('serializes trace event payloads and records durations', () => {
    const trace = createTrace({ agentWorkspaceId: workspaceId, projectId })
    const ev = addTraceEvent(trace.id, { type: 'tool_call', payload: { tool: 'grep', args: ['-r'] }, durationMs: 42 })
    expect(JSON.parse(ev.payload)).toEqual({ tool: 'grep', args: ['-r'] })
    expect(ev.durationMs).toBe(42)
    const bare = addTraceEvent(trace.id, { type: 'checkpoint' })
    expect(bare.payload).toBe('{}')
    expect(bare.durationMs).toBeNull()
  })
})

describe('observability — audit log', () => {
  it('records and lists audit entries, filtered by resource', () => {
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'secret.accessed', resourceType: 'secret', resourceId: 's1' })
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'task.approved', resourceType: 'task', resourceId: 't1' })
    expect(listAuditLog(projectId)).toHaveLength(2)
    expect(listAuditLog(projectId, { resourceType: 'secret' })).toHaveLength(1)
  })

  it('filters by actorId and resourceId, honors limit, and serializes metadata', () => {
    const otherActor = generateId()
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'a1', resourceType: 'task', resourceId: 't1', metadata: { reason: 'urgent' } })
    addAuditEntry({ projectId, actorType: 'agent', actorId: otherActor, action: 'a2', resourceType: 'task', resourceId: 't1' })
    addAuditEntry({ projectId, actorType: 'user', actorId: userId, action: 'a3', resourceType: 'task', resourceId: 't2' })

    expect(listAuditLog(projectId, { actorId: otherActor })).toHaveLength(1)
    expect(listAuditLog(projectId, { resourceId: 't1' })).toHaveLength(2)
    expect(listAuditLog(projectId, { limit: 2 })).toHaveLength(2)

    const [entry] = listAuditLog(projectId, { actorId: userId, resourceId: 't1' })
    expect(JSON.parse(entry!.metadata)).toEqual({ reason: 'urgent' })
  })
})

describe('observability — event log', () => {
  it('surfaces append-only events written by other domains', () => {
    createTask(projectId, { title: 'x', type: 'human' }, userId) // emits task.created
    const events = listEventLog(projectId, { type: 'task.created' })
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]?.type).toBe('task.created')
  })

  it('filters by domain, resourceType and resourceId, and honors limit', () => {
    const t1 = createTask(projectId, { title: 'one', type: 'human' }, userId)
    createTask(projectId, { title: 'two', type: 'human' }, userId)

    const byResource = listEventLog(projectId, { resourceType: 'task', resourceId: t1.id })
    expect(byResource).toHaveLength(1)
    expect(byResource[0]?.resourceId).toBe(t1.id)

    expect(listEventLog(projectId, { domain: 'agent-orchestration' }).length).toBeGreaterThanOrEqual(2)
    expect(listEventLog(projectId, { domain: 'no-such-domain' })).toHaveLength(0)
    expect(listEventLog(projectId, { limit: 1 })).toHaveLength(1)
  })
})
