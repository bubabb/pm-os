import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import {
  getDb,
  events,
  mutationQueue,
  syncConflicts,
  notifications,
  remoteLinks,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { pruneOldRecords } from './prune'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-11T12:00:00.000Z')
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString()

describe('pruneOldRecords', () => {
  let userId: string
  let projectId: string
  let credentialId: string
  let remoteLinkId: string

  beforeEach(() => {
    const ws = seedWorkspace()
    userId = ws.userId
    projectId = ws.projectId
    credentialId = seedCredential(projectId)
    remoteLinkId = generateId()
    getDb()
      .insert(remoteLinks)
      .values({
        id: remoteLinkId,
        projectId,
        credentialId,
        source: 'github',
        localType: 'task',
        localId: generateId(),
        remoteType: 'issue',
        remoteId: 'GH-1',
      })
      .run()
  })

  afterEach(() => destroyTestDb())

  function seedEvent(createdAt: string): string {
    const id = generateId()
    getDb()
      .insert(events)
      .values({ id, type: 'test.event', domain: 'integrations', actorType: 'system', createdAt })
      .run()
    return id
  }

  function seedMutation(status: string, updatedAt: string): string {
    const id = generateId()
    getDb()
      .insert(mutationQueue)
      .values({
        id,
        opId: generateId(),
        projectId,
        credentialId,
        source: 'github',
        kind: 'update',
        status,
        createdAt: updatedAt,
        updatedAt,
      })
      .run()
    return id
  }

  function seedConflict(resolvedAt: string | null, createdAt: string): string {
    const id = generateId()
    getDb()
      .insert(syncConflicts)
      .values({ id, projectId, remoteLinkId, resolvedAt, createdAt })
      .run()
    return id
  }

  function seedNotification(readAt: string | null, createdAt: string): string {
    const id = generateId()
    getDb()
      .insert(notifications)
      .values({ id, userId, type: 'mention', title: 't', body: 'b', readAt, createdAt })
      .run()
    return id
  }

  it('deletes only expired rows and never touches live data', () => {
    // events: >90d deleted, recent kept
    seedEvent(daysAgo(100))
    const freshEvent = seedEvent(daysAgo(10))

    // mutation_queue: terminal + >14d deleted; terminal-but-recent and all
    // non-terminal states kept regardless of age
    seedMutation('applied', daysAgo(20))
    seedMutation('cancelled', daysAgo(20))
    const recentApplied = seedMutation('applied', daysAgo(2))
    const oldPending = seedMutation('pending', daysAgo(100))
    const oldInFlight = seedMutation('in_flight', daysAgo(100))
    const oldFailed = seedMutation('failed', daysAgo(100))
    const oldConflicted = seedMutation('conflicted', daysAgo(100))

    // sync_conflicts: resolved >30d ago deleted; recently-resolved and
    // unresolved (even ancient) kept
    seedConflict(daysAgo(40), daysAgo(60))
    const recentResolved = seedConflict(daysAgo(5), daysAgo(60))
    const unresolved = seedConflict(null, daysAgo(200))

    // notifications: read >30d ago deleted; recently-read and unread kept
    seedNotification(daysAgo(40), daysAgo(60))
    const recentRead = seedNotification(daysAgo(5), daysAgo(60))
    const unread = seedNotification(null, daysAgo(200))

    const counts = pruneOldRecords(NOW)
    expect(counts).toEqual({ events: 1, mutations: 2, conflicts: 1, notifications: 1 })

    const db = getDb()
    expect(db.select({ id: events.id }).from(events).all().map((r) => r.id)).toEqual([freshEvent])
    expect(
      db.select({ id: mutationQueue.id }).from(mutationQueue).all().map((r) => r.id).sort(),
    ).toEqual([recentApplied, oldPending, oldInFlight, oldFailed, oldConflicted].sort())
    expect(
      db.select({ id: syncConflicts.id }).from(syncConflicts).all().map((r) => r.id).sort(),
    ).toEqual([recentResolved, unresolved].sort())
    expect(
      db.select({ id: notifications.id }).from(notifications).all().map((r) => r.id).sort(),
    ).toEqual([recentRead, unread].sort())
  })

  it('returns zero counts on an empty database', () => {
    expect(pruneOldRecords(NOW)).toEqual({ events: 0, mutations: 0, conflicts: 0, notifications: 0 })
  })
})
