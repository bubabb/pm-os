import { getDb, events, mutationQueue, syncConflicts, notifications } from '@creare/database'
import { and, inArray, isNotNull, lt } from 'drizzle-orm'

// Retention pruning for the tables that otherwise grow without bound. Invoked by
// the sync scheduler once shortly after startup and then daily. All timestamps in
// the schema are ISO-8601 strings, so plain lexicographic `<` comparisons against a
// cutoff ISO string are correct (same pattern as sync-engine's 7-day purge of
// external_event_cache — the only table that had retention before this).
//
// Windows:
//   events            — rows older than 90 days (highest-volume table; the event log
//                       is append-only in normal operation, retention pruning is the
//                       one sanctioned deletion path)
//   mutation_queue    — TERMINAL rows ('applied' | 'cancelled') whose updatedAt is
//                       older than 14 days. updatedAt is bumped on every status
//                       transition, so this measures time spent in the terminal
//                       state. pending/in_flight/failed/conflicted are NEVER touched.
//   sync_conflicts    — RESOLVED rows (resolvedAt IS NOT NULL) resolved more than
//                       30 days ago. Unresolved conflicts are never touched.
//   notifications     — READ rows (readAt IS NOT NULL) read more than 30 days ago.
//                       Unread notifications are never touched.

const DAY_MS = 24 * 60 * 60 * 1000

const EVENTS_RETENTION_DAYS = 90
const MUTATION_RETENTION_DAYS = 14
const CONFLICT_RETENTION_DAYS = 30
const NOTIFICATION_RETENTION_DAYS = 30

// Terminal mutation_queue states — the op is finished and the row is history.
// Everything else (pending, in_flight, failed, conflicted) is live or awaiting
// resolution and must survive pruning.
const TERMINAL_MUTATION_STATUSES = ['applied', 'cancelled']

export interface PruneCounts {
  events: number
  mutations: number
  conflicts: number
  notifications: number
}

// Deletes expired rows from each table. Each table is pruned in its own try/catch
// so one failure never blocks the others; failures log and leave that count at 0.
// `now` is injectable for tests; production callers use the default.
export function pruneOldRecords(now: Date = new Date()): PruneCounts {
  const db = getDb()
  const cutoff = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString()
  const counts: PruneCounts = { events: 0, mutations: 0, conflicts: 0, notifications: 0 }

  try {
    counts.events = db
      .delete(events)
      .where(lt(events.createdAt, cutoff(EVENTS_RETENTION_DAYS)))
      .run().changes
  } catch (err) {
    console.error('[creare] Prune failed for events:', err instanceof Error ? err.message : err)
  }

  try {
    counts.mutations = db
      .delete(mutationQueue)
      .where(
        and(
          inArray(mutationQueue.status, TERMINAL_MUTATION_STATUSES),
          lt(mutationQueue.updatedAt, cutoff(MUTATION_RETENTION_DAYS)),
        ),
      )
      .run().changes
  } catch (err) {
    console.error('[creare] Prune failed for mutation_queue:', err instanceof Error ? err.message : err)
  }

  try {
    counts.conflicts = db
      .delete(syncConflicts)
      .where(
        and(
          isNotNull(syncConflicts.resolvedAt),
          lt(syncConflicts.resolvedAt, cutoff(CONFLICT_RETENTION_DAYS)),
        ),
      )
      .run().changes
  } catch (err) {
    console.error('[creare] Prune failed for sync_conflicts:', err instanceof Error ? err.message : err)
  }

  try {
    counts.notifications = db
      .delete(notifications)
      .where(
        and(
          isNotNull(notifications.readAt),
          lt(notifications.readAt, cutoff(NOTIFICATION_RETENTION_DAYS)),
        ),
      )
      .run().changes
  } catch (err) {
    console.error('[creare] Prune failed for notifications:', err instanceof Error ? err.message : err)
  }

  console.log(
    `[creare] Retention prune: events=${counts.events} mutations=${counts.mutations} ` +
      `conflicts=${counts.conflicts} notifications=${counts.notifications}`,
  )
  return counts
}
