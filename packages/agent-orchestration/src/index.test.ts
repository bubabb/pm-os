import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedProject, seedUser, destroyTestDb } from '@creare/database/testing'
import { createTask, updateTask, addEdge, getReadyTasks } from './index'

let userId: string
let projectId: string

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
})
afterEach(() => destroyTestDb())

const task = (title: string) => createTask(projectId, { title, type: 'human' }, userId)

describe('agent-orchestration DAG', () => {
  it('adds a dependency edge between two tasks', () => {
    const a = task('a')
    const b = task('b')
    expect(addEdge(projectId, a.id, b.id, userId).ok).toBe(true)
  })

  it('rejects a self-loop', () => {
    const a = task('a')
    const res = addEdge(projectId, a.id, a.id, userId)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('self_loop')
  })

  it('rejects a duplicate edge', () => {
    const a = task('a')
    const b = task('b')
    addEdge(projectId, a.id, b.id, userId)
    expect(addEdge(projectId, a.id, b.id, userId).error).toBe('duplicate')
  })

  it('detects and rejects a cycle', () => {
    const a = task('a')
    const b = task('b')
    const c = task('c')
    expect(addEdge(projectId, a.id, b.id, userId).ok).toBe(true)
    expect(addEdge(projectId, b.id, c.id, userId).ok).toBe(true)
    // c -> a would close the loop a -> b -> c -> a
    expect(addEdge(projectId, c.id, a.id, userId).error).toBe('cycle_detected')
  })

  it('rejects an edge to a task in another project', () => {
    const a = task('a')
    const otherProject = seedProject(seedUser())
    const foreign = createTask(otherProject, { title: 'x', type: 'human' }, userId)
    expect(addEdge(projectId, a.id, foreign.id, userId).error).toBe('not_found')
  })

  it('getReadyTasks excludes tasks with incomplete dependencies', () => {
    const a = task('a')
    const b = task('b')
    addEdge(projectId, a.id, b.id, userId) // b depends on a

    let ready = getReadyTasks(projectId).map((t) => t.id)
    expect(ready).toContain(a.id) // no deps → ready
    expect(ready).not.toContain(b.id) // a not complete → blocked

    updateTask(a.id, { status: 'completed' }, userId)
    ready = getReadyTasks(projectId).map((t) => t.id)
    expect(ready).toContain(b.id) // dependency satisfied
  })
})
