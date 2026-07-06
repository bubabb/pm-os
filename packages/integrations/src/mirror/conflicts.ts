// Conflict resolution backend (docs/architecture/bidirectional-sync.md —
// "sync_conflicts: base/local/remote snapshots + resolution, surfaced to UI").
//
// Pull (mirror-sync.ts) and push (outbox.ts) PERSIST sync_conflicts rows when
// both sides moved off base; this module lists the open ones in human terms
// and applies the user's verdict:
//
//   dismiss     → keep both sides as-is; cancel the parked failed/conflicted
//                 op so the link stops counting as locally diverged.
//   remote_wins → apply the stored remote snapshot locally (column move + task
//                 update + lastSyncedHash = remote hash) and cancel local ops.
//   local_wins  → re-assert local state by enqueueing a fresh move_item op for
//                 the link's CURRENT column — the outbox drain does the actual
//                 push; this module only enqueues and marks the row resolved.
//
// House rule: this module NEVER writes boards tables directly — all local item
// writes go through @creare/boards (applyMirrorSnapshot); reads use the boards
// public getters. Conflict/queue/link rows are integrations-owned.

import {
  getDb,
  events,
  mutationQueue,
  remoteLinks,
  syncConflicts,
  tasks,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { applyMirrorSnapshot, getBoard, getBoardItem, getColumn } from '@creare/boards'
import type { MirrorApplyColumn } from '@creare/boards'
import type { IntegrationCredential, RemoteLink, SyncConflict } from '@creare/database'
import {
  connectorWriteCapabilities,
  enqueueBoardItemMove,
  enqueueForcedItemClose,
  enqueueForcedItemReopen,
  enqueueForcedItemUpdate,
} from './outbox'
import { columnSyncHash, PV2_STATUS_OPTION_REMOTE_TYPE } from './reconciler'
import type { IntegrationSource, MirrorItemSnapshot } from '../types'

export type ConflictResolution = 'local_wins' | 'remote_wins' | 'dismiss'

export interface ConflictView {
  id: string
  remoteLinkId: string
  boardId: string | null
  itemTitle: string
  localSummary: string
  remoteSummary: string
  createdAt: string
}

// ── JSON snapshot parsing (defensive — snapshots are free-form JSON text) ────

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// A pull-side conflict stores the fresh MirrorItemSnapshot verbatim in
// remoteSnapshot; a push-side conflict (outbox.markConflicted) stores only
// `{ version }`. Returns null when the snapshot is not an item snapshot.
function parseRemoteItemSnapshot(text: string): MirrorItemSnapshot | null {
  const raw = parseJson(text)
  if (
    typeof raw['remoteId'] !== 'string' ||
    typeof raw['title'] !== 'string' ||
    typeof raw['version'] !== 'string' ||
    typeof raw['contentHash'] !== 'string'
  ) return null
  const state = raw['state']
  return {
    remoteId: raw['remoteId'],
    containerRemoteId: typeof raw['containerRemoteId'] === 'string' ? raw['containerRemoteId'] : '',
    title: raw['title'],
    url: typeof raw['url'] === 'string' ? raw['url'] : null,
    statusRemoteId: typeof raw['statusRemoteId'] === 'string' ? raw['statusRemoteId'] : null,
    state: state === 'closed' || state === 'draft' ? state : 'open',
    archived: raw['archived'] === true,
    version: raw['version'],
    contentHash: raw['contentHash'],
  }
}

// ── Link helpers (read-only) ─────────────────────────────────────────────────

// Item/column links keep the remote board id (ProjectV2 node id) in
// containerRemoteId — see the outbox.ts convention block. That id resolves the
// BOARD link, whose localId is the local board.
function findBoardLink(link: RemoteLink): RemoteLink | null {
  if (link.containerRemoteId === null) return null
  const row = getDb()
    .select()
    .from(remoteLinks)
    .where(and(
      eq(remoteLinks.credentialId, link.credentialId),
      eq(remoteLinks.localType, 'board'),
      eq(remoteLinks.remoteId, link.containerRemoteId),
      isNull(remoteLinks.deletedAt),
    ))
    .get()
  return row ?? null
}

function findColumnLink(link: RemoteLink, statusRemoteId: string): RemoteLink | null {
  if (link.containerRemoteId === null) return null
  const row = getDb()
    .select()
    .from(remoteLinks)
    .where(and(
      eq(remoteLinks.credentialId, link.credentialId),
      eq(remoteLinks.remoteType, PV2_STATUS_OPTION_REMOTE_TYPE),
      eq(remoteLinks.remoteId, statusRemoteId),
      eq(remoteLinks.containerRemoteId, link.containerRemoteId),
      isNull(remoteLinks.deletedAt),
    ))
    .get()
  return row ?? null
}

// Local column name a remote status option maps to, or null when unmirrored.
function columnNameForStatus(link: RemoteLink, statusRemoteId: string | null): string | null {
  if (statusRemoteId === null) return null
  const colLink = findColumnLink(link, statusRemoteId)
  if (colLink === null) return null
  return getColumn(colLink.localId)?.name ?? null
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Open (unresolved) sync conflicts for a project, in human-readable form,
 * oldest first. When `boardId` is given, only conflicts on that mirrored
 * board's links are returned; an unmirrored/unknown boardId yields [].
 */
export async function listOpenConflicts(projectId: string, boardId?: string): Promise<ConflictView[]> {
  const db = getDb()

  const conditions = [
    eq(syncConflicts.projectId, projectId),
    isNull(syncConflicts.resolvedAt),
  ]
  if (boardId !== undefined) {
    const boardLink = db
      .select()
      .from(remoteLinks)
      .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, boardId)))
      .get()
    if (boardLink === undefined) return []
    // Same scoping getMirrorStatus uses: the board's item links carry the
    // remote board id in containerRemoteId under the same credential.
    conditions.push(
      eq(remoteLinks.credentialId, boardLink.credentialId),
      eq(remoteLinks.containerRemoteId, boardLink.remoteId),
    )
  }

  const rows = db
    .select({ conflict: syncConflicts, link: remoteLinks })
    .from(syncConflicts)
    .innerJoin(remoteLinks, eq(syncConflicts.remoteLinkId, remoteLinks.id))
    .where(and(...conditions))
    .orderBy(asc(syncConflicts.createdAt))
    .all()

  return rows.map(({ conflict, link }) => toConflictView(conflict, link))
}

function toConflictView(conflict: SyncConflict, link: RemoteLink): ConflictView {
  const remote = parseRemoteItemSnapshot(conflict.remoteSnapshot)

  // Current local placement: link.localId → board_item → column.
  const boardItem = link.localType === 'board_item' ? getBoardItem(link.localId) : null
  let localTitle: string | null = null
  let localSummary: string
  if (boardItem === null) {
    localSummary = 'Local item no longer exists'
  } else {
    const columnName = getColumn(boardItem.columnId)?.name ?? 'unknown column'
    localSummary = `In column "${columnName}" locally (has an unsynced local change)`
    const task = getDb().select().from(tasks).where(eq(tasks.id, boardItem.taskId)).get()
    localTitle = task?.title ?? null
  }

  let remoteSummary: string
  if (remote !== null) {
    const columnName = columnNameForStatus(link, remote.statusRemoteId)
    const placement = columnName !== null
      ? `In column "${columnName}" remotely`
      : remote.statusRemoteId !== null
        ? `In remote status ${remote.statusRemoteId}`
        : 'No status remotely'
    remoteSummary = `${placement} (${remote.state})`
  } else {
    const rawRemote = parseJson(conflict.remoteSnapshot)
    remoteSummary = typeof rawRemote['version'] === 'string'
      ? `Remote changed (version ${rawRemote['version']})`
      : 'Remote changed'
  }

  return {
    id: conflict.id,
    remoteLinkId: link.id,
    boardId: findBoardLink(link)?.localId ?? null,
    itemTitle: remote?.title ?? localTitle ?? 'Unknown item',
    localSummary,
    remoteSummary,
    createdAt: conflict.createdAt,
  }
}

// ── Resolve ──────────────────────────────────────────────────────────────────

/**
 * Apply the user's verdict on an open conflict. Throws a clear Error (never
 * crashes deeper) for an unknown conflictId, an already-resolved row, or a
 * resolution the stored snapshots cannot support.
 *
 * `getCredential` mirrors drainMutationQueue's token resolver and is reserved
 * for resolutions that must talk to the remote directly; Phase 1 resolutions
 * stay local — local_wins pushes via the outbox drain, not from here.
 */
export async function resolveConflict(
  conflictId: string,
  resolution: ConflictResolution,
  _getCredential: (credentialId: string) => Promise<{ credential: IntegrationCredential; token: string }>,
): Promise<void> {
  const db = getDb()

  const conflict = db.select().from(syncConflicts).where(eq(syncConflicts.id, conflictId)).get()
  if (conflict === undefined) {
    throw new Error(`resolveConflict: no sync conflict with id ${conflictId}`)
  }
  if (conflict.resolvedAt !== null) {
    throw new Error(`resolveConflict: conflict ${conflictId} is already resolved (${conflict.resolution ?? 'unknown'})`)
  }
  const link = db.select().from(remoteLinks).where(eq(remoteLinks.id, conflict.remoteLinkId)).get()
  if (link === undefined) {
    throw new Error(`resolveConflict: conflict ${conflictId} references missing remote link ${conflict.remoteLinkId}`)
  }

  let cancelledOps = 0
  let enqueuedOpId: string | null = null

  if (resolution === 'dismiss') {
    // No data change on either side — just stop counting the divergence:
    // parked failed/conflicted ops would otherwise keep planReconcile
    // reporting this link as a conflict on every pull.
    cancelledOps = cancelOps(link.id, ['failed', 'conflicted'])
  } else if (resolution === 'remote_wins') {
    applyRemoteWins(conflict, link)
    // The local intent is being discarded — cancel everything still waiting
    // to push it (pending included), so the outbox can't re-assert it later.
    cancelledOps = cancelOps(link.id, ['pending', 'failed', 'conflicted'])
  } else {
    // local_wins: re-assert the FULL local delta (column + title/body +
    // open-state) so LOCAL actually wins — not just the column move (which was
    // the old silent-loss bug). Content/state ops carry force:true so the drift
    // probe overwrites the drifted remote instead of re-conflicting. Ops the
    // connector can't perform (e.g. Jira/Confluence reopen_item) are SKIPPED
    // with a warn rather than enqueued to terminally fail.
    if (link.localType !== 'board_item') {
      throw new Error(`resolveConflict: local_wins only supports board_item links (conflict ${conflictId} targets a ${link.localType})`)
    }
    const boardItem = getBoardItem(link.localId)
    if (boardItem === null) {
      throw new Error(`resolveConflict: board item ${link.localId} for conflict ${conflictId} no longer exists — resolve as remote_wins or dismiss instead`)
    }

    // Column move — already last-write-wins in the drift probe (no force flag).
    enqueuedOpId = await enqueueBoardItemMove(boardItem.id, boardItem.columnId)
    if (enqueuedOpId === null) {
      throw new Error(`resolveConflict: could not enqueue the local_wins push for board item ${boardItem.id} — conflict left open`)
    }
    // Shield every op we enqueue from the cancel sweep below (the move itself
    // may be a parked 'failed' row when the target column is unmapped).
    const shield = new Set<string>([enqueuedOpId])

    const caps = connectorWriteCapabilities(link.source as IntegrationSource)
    const remote = parseRemoteItemSnapshot(conflict.remoteSnapshot)
    const task = getDb().select().from(tasks).where(eq(tasks.id, boardItem.taskId)).get()

    // Title / body → forced update_item. Push when local title differs from the
    // remote snapshot (or remote is unknown — a push-side conflict carries none).
    if (task !== undefined) {
      if (caps.includes('update_item')) {
        if (remote === null || task.title !== remote.title) {
          const patch: { title?: string; body?: string } = { title: task.title }
          if (task.description !== null) patch.body = task.description
          const upId = await enqueueForcedItemUpdate(boardItem.id, patch)
          if (upId !== null) shield.add(upId)
        }
      } else {
        console.warn(`resolveConflict: ${link.source} does not support update_item — local title/body NOT re-pushed for conflict ${conflictId}`)
      }
    }

    // Open/closed → forced close_item / reopen_item to re-assert the LOCAL state.
    // With a known remote (pull-side conflict) act only on a real difference; with an
    // UNKNOWN remote (a push-side conflict carries only { version }, so remote===null)
    // re-assert the local state directly — otherwise a local close/reopen is silently
    // dropped here and then reverted on the next pull.
    if (task !== undefined) {
      const localClosed = task.status === 'completed'
      const remoteClosed = remote?.state === 'closed'
      if (localClosed && (remote === null || !remoteClosed)) {
        if (caps.includes('close_item')) {
          const cid = await enqueueForcedItemClose(boardItem.id)
          if (cid !== null) shield.add(cid)
        } else {
          console.warn(`resolveConflict: ${link.source} does not support close_item — local close NOT re-pushed for conflict ${conflictId}`)
        }
      } else if (!localClosed && (remote === null || remoteClosed)) {
        if (caps.includes('reopen_item')) {
          const rid = await enqueueForcedItemReopen(boardItem.id)
          if (rid !== null) shield.add(rid)
        } else {
          console.warn(`resolveConflict: ${link.source} does not support reopen_item — local reopen NOT re-pushed for conflict ${conflictId}`)
        }
      }
    }

    // Cancel AFTER the fresh ops are in — they are shielded so they can't cancel
    // themselves; only the OLD parked failed/conflicted ops are swept.
    cancelledOps = cancelOps(link.id, ['failed', 'conflicted'], shield)
  }

  const resolutionLabel = resolution === 'dismiss' ? 'dismissed' : resolution
  db.update(syncConflicts)
    .set({ resolution: resolutionLabel, resolvedAt: new Date().toISOString() })
    .where(eq(syncConflicts.id, conflictId))
    .run()

  db.insert(events)
    .values({
      id: generateId(),
      type: 'integration.conflict.resolved',
      domain: 'integrations',
      projectId: conflict.projectId,
      actorType: 'user',
      actorId: null,
      resourceType: 'sync_conflict',
      resourceId: conflict.id,
      payload: JSON.stringify({
        conflictId: conflict.id,
        resolution: resolutionLabel,
        remoteLinkId: link.id,
        cancelledOps,
        ...(enqueuedOpId !== null ? { enqueuedOpId } : {}),
      }),
    })
    .run()
}

// Cancel this link's mutation_queue rows in the given statuses so they stop
// counting as local divergence (UNRESOLVED_OP_STATUSES). Returns the count.
// `exceptOpIds` shields just-enqueued ops from their own sweep.
function cancelOps(remoteLinkId: string, statuses: string[], exceptOpIds: Set<string> = new Set()): number {
  const db = getDb()
  const rows = db
    .select({ id: mutationQueue.id, opId: mutationQueue.opId })
    .from(mutationQueue)
    .where(and(eq(mutationQueue.remoteLinkId, remoteLinkId), inArray(mutationQueue.status, statuses)))
    .all()
  const ids = rows.filter((r) => !exceptOpIds.has(r.opId)).map((r) => r.id)
  if (ids.length === 0) return 0
  db.update(mutationQueue)
    .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
    .where(inArray(mutationQueue.id, ids))
    .run()
  return ids.length
}

// Apply the stored remote snapshot locally through boards.applyMirrorSnapshot
// (single-item MirrorApply): moves the board_item to the remote's column,
// updates the backing task, and stamps the link's lastSyncedHash with the
// remote contentHash — the divergence is gone from the next pull's view.
function applyRemoteWins(conflict: SyncConflict, link: RemoteLink): void {
  const remote = parseRemoteItemSnapshot(conflict.remoteSnapshot)
  if (remote === null) {
    throw new Error(`resolveConflict: conflict ${conflict.id} has no remote item snapshot to apply — pull the mirror and resolve the refreshed conflict instead`)
  }
  const boardLink = findBoardLink(link)
  if (boardLink === null) {
    throw new Error(`resolveConflict: cannot resolve the mirrored board for link ${link.id} (conflict ${conflict.id})`)
  }
  const board = getBoard(boardLink.localId)
  if (board === null) {
    throw new Error(`resolveConflict: mirrored board ${boardLink.localId} for conflict ${conflict.id} no longer exists`)
  }

  // Include ONLY the item's target column, described by its CURRENT local
  // shape, so applyMirrorSnapshot maps the item into it without touching the
  // rest of the board (an empty columns list would dump the item into the
  // board's first column).
  const columns: MirrorApplyColumn[] = []
  if (remote.statusRemoteId !== null) {
    const colLink = findColumnLink(link, remote.statusRemoteId)
    const column = colLink !== null ? getColumn(colLink.localId) : null
    if (column === null) {
      throw new Error(`resolveConflict: remote status ${remote.statusRemoteId} has no local column for conflict ${conflict.id} — pull the mirror first`)
    }
    columns.push({
      remoteId: remote.statusRemoteId,
      name: column.name,
      position: column.position,
      isTerminal: column.isTerminal,
      syncHash: columnSyncHash(column),
    })
  }

  applyMirrorSnapshot({
    projectId: link.projectId,
    credentialId: link.credentialId,
    source: link.source,
    boardId: board.id,
    board: {
      remoteId: boardLink.remoteId,
      title: board.name,
      url: boardLink.remoteUrl,
      version: boardLink.remoteVersion ?? remote.version,
      // Board-link convention: containerRemoteId carries the Status FIELD id.
      statusFieldRemoteId: boardLink.containerRemoteId,
    },
    columns,
    upsertItems: [{
      remoteId: remote.remoteId,
      title: remote.title,
      url: remote.url,
      columnRemoteId: remote.statusRemoteId,
      state: remote.state,
      version: remote.version,
      contentHash: remote.contentHash,
    }],
    deleteRemoteIds: [],
  })
}
