import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, destroyTestDb } from '@pm-os/database/testing'
import { recordLearning, listLearnings, recallLearnings } from './index'

let userId: string
let projectId: string

beforeEach(() => {
  ;({ userId, projectId } = seedWorkspace())
})
afterEach(() => destroyTestDb())

describe('team memory', () => {
  it('records and lists learnings', () => {
    recordLearning(projectId, { source: 'manual', title: 'First', content: 'a', tags: ['db'] }, userId)
    recordLearning(projectId, { source: 'review', title: 'Second', content: 'b', tags: ['auth'] }, userId)
    const all = listLearnings(projectId)
    expect(all).toHaveLength(2)
    // Both present — exact order isn't asserted: inserts in the same millisecond tie on
    // created_at and SQLite gives no ordering guarantee among ties.
    expect(all.map((l) => l.title).sort()).toEqual(['First', 'Second'])
  })

  it('filters by source', () => {
    recordLearning(projectId, { source: 'manual', title: 'm', content: 'x' }, userId)
    recordLearning(projectId, { source: 'eval', title: 'e', content: 'y' }, userId)
    expect(listLearnings(projectId, { source: 'eval' })).toHaveLength(1)
  })

  it('recalls by tag overlap, ranked', () => {
    recordLearning(projectId, { source: 'manual', title: 'Auth tip', content: 'use JWT', tags: ['auth', 'security'] }, userId)
    recordLearning(projectId, { source: 'manual', title: 'DB tip', content: 'use WAL', tags: ['db'] }, userId)
    const hits = recallLearnings(projectId, { tags: ['auth'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.title).toBe('Auth tip')
  })

  it('recalls by keyword in title/content', () => {
    recordLearning(projectId, { source: 'manual', title: 'Rollback', content: 'deployments are non-destructive', tags: [] }, userId)
    recordLearning(projectId, { source: 'manual', title: 'Unrelated', content: 'nothing here', tags: [] }, userId)
    const hits = recallLearnings(projectId, { text: 'non-destructive' })
    expect(hits.map((h) => h.title)).toEqual(['Rollback'])
  })

  it('returns recent learnings when no query criteria given', () => {
    recordLearning(projectId, { source: 'manual', title: 'A', content: 'a' }, userId)
    recordLearning(projectId, { source: 'manual', title: 'B', content: 'b' }, userId)
    expect(recallLearnings(projectId, { limit: 1 })).toHaveLength(1)
  })
})
