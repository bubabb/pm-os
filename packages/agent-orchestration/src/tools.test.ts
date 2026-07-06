import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedProject, seedUser, destroyTestDb } from '@pm-os/database/testing'
import { createTask, listTasks } from './index'
import { listAgentTools, executeAgentTool, type ToolContext } from './tools'

let userId: string
let projectId: string
let agentId: string
const PARENT_TASK_ID = 'parent-task-1'

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
  agentId = 'agent-workspace-1'
})
afterEach(() => destroyTestDb())

const ctx = (
  allowedTools: string[] | '*',
  parentTaskId: string = PARENT_TASK_ID,
): ToolContext => ({
  projectId,
  actorId: agentId,
  allowedTools,
  parentTaskId,
})

const ALL_BUILT_INS = ['list_tasks', 'get_task', 'get_project_summary', 'create_followup_task']

describe('listAgentTools — deny-by-default', () => {
  it('returns nothing when nothing is allowed', () => {
    expect(listAgentTools(ctx([]))).toEqual([])
  })

  it('returns only the explicitly allowed tools', () => {
    const names = listAgentTools(ctx(['list_tasks', 'get_task'])).map((t) => t.name)
    expect(names.sort()).toEqual(['get_task', 'list_tasks'])
  })

  it("returns all built-ins for the wildcard '*'", () => {
    const names = listAgentTools(ctx('*')).map((t) => t.name)
    expect(names.sort()).toEqual([...ALL_BUILT_INS].sort())
  })

  it('exposes a real JSON-Schema inputSchema per tool', () => {
    for (const tool of listAgentTools(ctx('*'))) {
      expect(tool.inputSchema['type']).toBe('object')
      expect(tool.inputSchema).toHaveProperty('properties')
      expect(tool.inputSchema).toHaveProperty('required')
    }
  })
})

describe('executeAgentTool — happy paths, scoped to the project', () => {
  it('runs list_tasks and returns only this project\'s tasks', async () => {
    createTask(projectId, { title: 'mine', type: 'human' }, userId)
    const otherProject = seedProject(seedUser())
    createTask(otherProject, { title: 'theirs', type: 'human' }, userId)

    const res = await executeAgentTool('list_tasks', {}, ctx('*'))
    expect(res.isError).toBe(false)
    const rows = JSON.parse(res.content) as Array<{ title: string }>
    expect(rows.map((r) => r.title)).toEqual(['mine'])
  })

  it('runs list_tasks with a status filter', async () => {
    const t = createTask(projectId, { title: 'a', type: 'human' }, userId)
    createTask(projectId, { title: 'b', type: 'human' }, userId)
    // t is pending by default; nothing is completed
    const res = await executeAgentTool('list_tasks', { status: 'completed' }, ctx('*'))
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content)).toEqual([])
    expect(t.status).toBe('pending')
  })

  it('runs get_task for a task in this project', async () => {
    const t = createTask(projectId, { title: 'x', type: 'human' }, userId)
    const res = await executeAgentTool('get_task', { taskId: t.id }, ctx('*'))
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content).id).toBe(t.id)
  })

  it('runs get_project_summary with status counts', async () => {
    createTask(projectId, { title: 'a', type: 'human' }, userId)
    createTask(projectId, { title: 'b', type: 'human' }, userId)
    const res = await executeAgentTool('get_project_summary', {}, ctx('*'))
    expect(res.isError).toBe(false)
    const summary = JSON.parse(res.content) as { total: number; byStatus: Record<string, number> }
    expect(summary.total).toBe(2)
    expect(summary.byStatus['pending']).toBe(2)
  })

  it('runs create_followup_task and creates a pending human task', async () => {
    const res = await executeAgentTool(
      'create_followup_task',
      { title: 'follow up', priority: 'high' },
      ctx('*'),
    )
    expect(res.isError).toBe(false)
    const { taskId } = JSON.parse(res.content) as { taskId: string }

    const created = listTasks(projectId).find((t) => t.id === taskId)
    expect(created).toBeDefined()
    expect(created?.type).toBe('human')
    expect(created?.priority).toBe('high')
    expect(created?.status).toBe('pending')
  })
})

describe('create_followup_task — idempotent across crash-and-retry', () => {
  const create = (title: string, parentTaskId?: string) =>
    executeAgentTool('create_followup_task', { title }, ctx('*', parentTaskId))

  it('twice with the same parent + title creates exactly ONE task (second returns existing)', async () => {
    const first = await create('Deploy the fix')
    expect(first.isError).toBe(false)
    const firstOut = JSON.parse(first.content) as { taskId: string; alreadyExists?: boolean }
    expect(firstOut.alreadyExists).toBeUndefined()

    // Simulates the crash-and-retry: same parent task re-emits the same tool call.
    const second = await create('Deploy the fix')
    expect(second.isError).toBe(false)
    const secondOut = JSON.parse(second.content) as { taskId: string; alreadyExists?: boolean }
    expect(secondOut.taskId).toBe(firstOut.taskId) // same task returned
    expect(secondOut.alreadyExists).toBe(true)

    // Exactly one follow-up exists in the project.
    expect(listTasks(projectId).length).toBe(1)
  })

  it('dedup is insensitive to title case + surrounding whitespace', async () => {
    const first = await create('Deploy the fix')
    const second = await create('  DEPLOY the FIX  ')
    expect(JSON.parse(second.content).taskId).toBe(JSON.parse(first.content).taskId)
    expect(listTasks(projectId).length).toBe(1)
  })

  it('a different title → a new task', async () => {
    await create('Deploy the fix')
    const other = await create('Write the changelog')
    expect(JSON.parse(other.content).alreadyExists).toBeUndefined()
    expect(listTasks(projectId).length).toBe(2)
  })

  it('a different parent task → a new task (no cross-parent dedup)', async () => {
    const first = await create('Deploy the fix', 'parent-A')
    const second = await create('Deploy the fix', 'parent-B')
    expect(JSON.parse(second.content).taskId).not.toBe(JSON.parse(first.content).taskId)
    expect(JSON.parse(second.content).alreadyExists).toBeUndefined()
    expect(listTasks(projectId).length).toBe(2)
  })
})

describe('executeAgentTool — permission + error handling (never throws)', () => {
  it('denies a tool that is not allowed, without side effects', async () => {
    const before = listTasks(projectId).length
    const res = await executeAgentTool(
      'create_followup_task',
      { title: 'sneaky' },
      ctx(['list_tasks']), // create_followup_task NOT allowed
    )
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/not permitted/i)
    expect(listTasks(projectId).length).toBe(before) // nothing created
  })

  it('returns isError for an unknown tool without throwing', async () => {
    const res = await executeAgentTool('rm_rf', { path: '/' }, ctx('*'))
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/unknown tool/i)
  })

  it('returns isError for bad input without throwing', async () => {
    const res = await executeAgentTool('get_task', {}, ctx('*')) // missing taskId
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/taskId/)
  })

  it('get_task on another project\'s task → isError', async () => {
    const otherProject = seedProject(seedUser())
    const foreign = createTask(otherProject, { title: 'foreign', type: 'human' }, userId)
    const res = await executeAgentTool('get_task', { taskId: foreign.id }, ctx('*'))
    expect(res.isError).toBe(true)
    expect(res.content).toMatch(/not found in this project/i)
  })
})
