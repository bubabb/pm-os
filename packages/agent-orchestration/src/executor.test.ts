import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, destroyTestDb } from '@pm-os/database/testing'
import { getDb, traces, traceEvents, events } from '@pm-os/database'
import { eq, and } from 'drizzle-orm'

// Mock the reasoning engine so no real model/CLI is invoked. supportsTools is true only
// for 'anthropic' (matching the real SDK), llmAvailable always true, and claude-cli needs
// no key. The per-test `completeMock` drives the loop.
const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }))
vi.mock('@pm-os/ai-sdk', () => ({
  complete: (req: unknown, key: unknown) => completeMock(req, key),
  supportsTools: (p: string) => p === 'anthropic',
  llmAvailable: () => true,
  providerNeedsKey: (p: string) => p !== 'claude-cli',
}))

import { createWorkspace, createTask, updateTask, startTask, cancelTask, recoverStaleAgentTasks, getTask } from './index'

let projectId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  completeMock.mockReset()
})
afterEach(() => destroyTestDb())

interface Over { content?: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>; costCents?: number; inputTokens?: number; outputTokens?: number }
function resp(over: Over = {}): Record<string, unknown> {
  return {
    content: over.content ?? '',
    toolCalls: over.toolCalls,
    inputTokens: over.inputTokens ?? 5,
    outputTokens: over.outputTokens ?? 10,
    costCents: over.costCents ?? 1,
    durationMs: 3,
    model: 'test-model',
    provider: 'claude-cli',
  }
}
function agentTask(opts: { workspaceId?: string } = {}): string {
  return createTask(projectId, { title: 'Do the thing', description: 'details', type: 'agent', agentWorkspaceId: opts.workspaceId }).id
}
function traceFor(taskId: string) {
  return getDb().select().from(traces).where(eq(traces.taskId, taskId)).all()[0]
}

describe('executor — startTask', () => {
  it('single-step run: completes the task, stores the deliverable, records a completed trace + events', async () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'claude-cli', modelId: 'm' })
    const id = agentTask({ workspaceId: ws.id })
    completeMock.mockResolvedValueOnce(resp({ content: 'the deliverable', costCents: 2 }))

    await startTask(id)

    const task = getTask(id)!
    expect(task.status).toBe('completed')
    expect(task.result).toBe('the deliverable')
    const trace = traceFor(id)!
    expect(trace.status).toBe('completed')
    expect(trace.costCents).toBe(2)
    expect(trace.outputTokens).toBe(10)
    const types = getDb().select().from(traceEvents).where(eq(traceEvents.traceId, trace.id)).all().map((e) => e.type)
    expect(types).toContain('llm_call')
    expect(types).toContain('checkpoint')
    const evTypes = getDb().select().from(events).where(eq(events.resourceId, id)).all().map((e) => e.type)
    expect(evTypes).toContain('task.started')
    expect(evTypes).toContain('task.completed')
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('tool loop: runs a tool call then finishes, emitting tool_call + tool_result trace events', async () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'anthropic', modelId: 'm', permissionScope: { tools: '*' } })
    const id = agentTask({ workspaceId: ws.id })
    completeMock
      .mockResolvedValueOnce(resp({ content: '', toolCalls: [{ id: 't1', name: 'list_tasks', input: {} }] }))
      .mockResolvedValueOnce(resp({ content: 'done after using a tool' }))

    await startTask(id, { resolveApiKey: () => 'key' })

    expect(completeMock).toHaveBeenCalledTimes(2)
    const task = getTask(id)!
    expect(task.status).toBe('completed')
    expect(task.result).toBe('done after using a tool')
    const trace = traceFor(id)!
    const types = getDb().select().from(traceEvents).where(eq(traceEvents.traceId, trace.id)).all().map((e) => e.type)
    expect(types).toContain('tool_call')
    expect(types).toContain('tool_result')
  })

  it('does NOT pass tools to a provider without tool support (claude-cli) — single step, no tool events', async () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'claude-cli', modelId: 'm', permissionScope: { tools: '*' } })
    const id = agentTask({ workspaceId: ws.id })
    completeMock.mockResolvedValueOnce(resp({ content: 'plain result' }))

    await startTask(id)

    const req = completeMock.mock.calls[0]![0] as { tools?: unknown }
    expect(req.tools).toBeUndefined()
    expect(getTask(id)!.status).toBe('completed')
  })

  it('guardrail: a run that exceeds the workspace daily cost cap fails the task', async () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'claude-cli', modelId: 'm', dailyCostLimitCents: 1 })
    const id = agentTask({ workspaceId: ws.id })
    completeMock.mockResolvedValue(resp({ content: 'x', costCents: 5 })) // 5c > 1c cap after first call

    await startTask(id, { maxIterations: 5 })

    expect(getTask(id)!.status).toBe('failed')
    expect(traceFor(id)!.status).toBe('failed')
  })

  it('claims atomically: a non-pending task is not run, a non-agent task is skipped', async () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'claude-cli', modelId: 'm' })
    const id = agentTask({ workspaceId: ws.id })
    updateTask(id, { status: 'completed' })
    await startTask(id)
    expect(completeMock).not.toHaveBeenCalled()

    const human = createTask(projectId, { title: 'human', type: 'human' }).id
    await startTask(human)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('cancelTask on a pending task marks it cancelled without running', async () => {
    const id = agentTask()
    const t = cancelTask(id)
    expect(t?.status).toBe('cancelled')
    await startTask(id)
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('recoverStaleAgentTasks resets in_progress agent tasks to pending and fails their open traces', () => {
    const ws = createWorkspace(projectId, { name: 'W', modelProvider: 'claude-cli', modelId: 'm' })
    const id = agentTask({ workspaceId: ws.id })
    updateTask(id, { status: 'in_progress' })
    getDb().insert(traces).values({ id: 'tr1', taskId: id, agentWorkspaceId: ws.id, projectId, status: 'running', inputTokens: 0, outputTokens: 0, costCents: 0, startedAt: new Date().toISOString() }).run()

    const n = recoverStaleAgentTasks()

    expect(n).toBe(1)
    expect(getTask(id)!.status).toBe('pending')
    const tr = getDb().select().from(traces).where(and(eq(traces.id, 'tr1'), eq(traces.status, 'failed'))).all()
    expect(tr).toHaveLength(1)
  })
})
