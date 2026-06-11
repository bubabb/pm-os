// Mirror pull/import engine (docs/architecture/bidirectional-sync.md §"Reconciliation
// (pull) and outbox (push)", Phase 1 build item: mirror/mirror-sync.ts).
//
// Orchestrates the IMPURE side of a pull: fetch a fresh remote snapshot, run the
// pure planReconcile() against the stored remote_links + outstanding mutation
// queue, translate the plan into a plain-data MirrorApply, and hand ALL local
// writes to boards.applyMirrorSnapshot() (one transaction, owned by Domain 4).
//
// Token handling: the caller (routes layer) resolves the credential's plaintext
// token via the secrets layer — this module NEVER decrypts anything.
//
// Error policy: GraphQL/scope/rate-limit errors from GitHubProjectsClient
// propagate to the caller after a `mirror.pull.failed` event is recorded —
// the route maps them to HTTP responses / read-only banners.

import {
  getDb,
  events,
  remoteLinks,
  mutationQueue,
  syncConflicts,
  integrationCredentials,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import { applyMirrorSnapshot } from '@creare/boards'
import type { MirrorApply, MirrorApplyColumn, MirrorApplyItem } from '@creare/boards'
import type { IntegrationCredential, RemoteLink } from '@creare/database'
import { GitHubProjectsClient } from '../connectors/github-projects'
import {
  planReconcile,
  columnSyncHash,
  UNRESOLVED_OP_STATUSES,
  PV2_ITEM_REMOTE_TYPE,
  PV2_STATUS_OPTION_REMOTE_TYPE,
} from './reconciler'
import type { IntegrationSource, MirrorBoardSnapshot, MirrorColumnSnapshot, MirrorItemSnapshot } from '../types'

// Mutation statuses that count as "waiting to be pushed" — the chip's
// pendingPushes number. Failed pushes are surfaced separately (failedPushes);
// the pull-side divergence signal uses the reconciler's UNRESOLVED_OP_STATUSES
// (which additionally includes failed/conflicted).
const ACTIVE_PUSH_STATUSES = ['pending', 'in_flight'] as const

export interface MirrorStatus {
  linked: boolean
  source: IntegrationSource | null
  remoteUrl: string | null
  lastPulledAt: string | null
  pendingPushes: number
  openConflicts: number
  failedPushes: number
}

// ── Snapshot → MirrorApply mapping ──────────────────────────────────────────

function toApplyColumn(column: MirrorColumnSnapshot): MirrorApplyColumn {
  return {
    remoteId: column.remoteId,
    name: column.name,
    position: column.position,
    isTerminal: column.isTerminal,
    // applyMirrorSnapshot stores this in link.lastSyncedHash; planReconcile
    // compares against the same encoding — columnSyncHash is the single source.
    syncHash: columnSyncHash(column),
  }
}

function toApplyItem(item: MirrorItemSnapshot): MirrorApplyItem {
  return {
    remoteId: item.remoteId,
    title: item.title,
    url: item.url,
    columnRemoteId: item.statusRemoteId,
    state: item.state,
    version: item.version,
    contentHash: item.contentHash,
  }
}

// ── Event log helper (same pattern as sync-engine.ts) ───────────────────────

async function emitMirrorEvent(
  type: 'mirror.pull.started' | 'mirror.pull.completed' | 'mirror.pull.failed',
  projectId: string,
  resourceType: 'integration_credential' | 'board',
  resourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await getDb().insert(events).values({
    id: generateId(),
    type,
    domain: 'integrations',
    projectId,
    actorType: 'system',
    actorId: null,
    resourceType,
    resourceId,
    payload: JSON.stringify(payload),
  })
}

// ── Import (initial pull — creates the local mirrored board) ────────────────

/**
 * Import a remote GitHub ProjectV2 as a new mirrored local board.
 * Everything in the snapshot is applied: all columns, all items as upserts,
 * no deletes (there is no local state yet to delete against).
 */
export async function createMirror(
  credential: IntegrationCredential,
  token: string,
  remoteProjectId: string,
): Promise<{ boardId: string }> {
  const { id: credentialId, projectId, source } = credential

  await emitMirrorEvent('mirror.pull.started', projectId, 'integration_credential', credentialId, {
    credentialId,
    source,
    projectId,
    remoteProjectId,
    phase: 'import',
  })

  try {
    const snapshot: MirrorBoardSnapshot =
      await new GitHubProjectsClient(token).fetchProjectSnapshot(remoteProjectId)

    const apply: MirrorApply = {
      projectId,
      credentialId,
      source,
      boardId: null, // null = create the board (initial import)
      board: {
        remoteId: snapshot.remoteId,
        title: snapshot.title,
        url: snapshot.url,
        version: snapshot.version,
        // Stored on the BOARD link's containerRemoteId — the push side
        // (outbox.enqueueBoardItemMove) reads the Status FIELD id from there.
        statusFieldRemoteId: snapshot.statusFieldRemoteId,
      },
      columns: snapshot.columns.map(toApplyColumn),
      upsertItems: snapshot.items.map(toApplyItem),
      deleteRemoteIds: [],
    }

    const { boardId } = applyMirrorSnapshot(apply)

    await emitMirrorEvent('mirror.pull.completed', projectId, 'board', boardId, {
      credentialId,
      source,
      projectId,
      remoteProjectId,
      boardId,
      phase: 'import',
      pulled: snapshot.items.length,
      conflicts: 0,
    })

    return { boardId }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    await emitMirrorEvent('mirror.pull.failed', projectId, 'integration_credential', credentialId, {
      credentialId,
      source,
      projectId,
      remoteProjectId,
      phase: 'import',
      error: errorMessage,
    })
    throw err
  }
}

// ── Incremental pull (reconcile remote → local) ─────────────────────────────

/**
 * Pull the latest remote state into an existing mirrored board.
 * Three-way reconciliation via planReconcile: new items and safe remote
 * updates are applied; remote deletes are applied; conflicts (remote changed
 * AND an unresolved push op targets the same link) are SKIPPED locally and
 * PERSISTED as open sync_conflicts rows — push-side policy or the user decides
 * their fate, the pull never clobbers local intent.
 */
export async function pullMirror(
  credential: IntegrationCredential,
  token: string,
  boardId: string,
): Promise<{ pulled: number; conflicts: number }> {
  const db = getDb()
  const { id: credentialId, projectId, source } = credential

  const [boardLink] = await db
    .select()
    .from(remoteLinks)
    .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, boardId)))
    .limit(1)
  if (boardLink === undefined) {
    throw new Error(`pullMirror: board ${boardId} has no remote link — not a mirrored board`)
  }
  const projectV2Id = boardLink.remoteId

  await emitMirrorEvent('mirror.pull.started', projectId, 'board', boardId, {
    credentialId,
    source,
    projectId,
    boardId,
    remoteProjectId: projectV2Id,
    phase: 'pull',
  })

  try {
    // Existing item + column links for THIS board (applyMirrorSnapshot stamps
    // containerRemoteId = board.remoteId on both link kinds, which scopes the
    // query when one credential mirrors several projects).
    const links: RemoteLink[] = await db
      .select()
      .from(remoteLinks)
      .where(and(
        eq(remoteLinks.projectId, projectId),
        eq(remoteLinks.credentialId, credentialId),
        eq(remoteLinks.containerRemoteId, projectV2Id),
        inArray(remoteLinks.remoteType, [PV2_ITEM_REMOTE_TYPE, PV2_STATUS_OPTION_REMOTE_TYPE]),
      ))

    // Outstanding local pushes — the local-divergence signal for the planner.
    // UNRESOLVED includes failed/conflicted: a push that FAILED still means
    // local moved off base, and a remote-wins update would silently revert it.
    const pendingOps = await db
      .select()
      .from(mutationQueue)
      .where(and(
        eq(mutationQueue.credentialId, credentialId),
        inArray(mutationQueue.status, [...UNRESOLVED_OP_STATUSES]),
      ))

    const snapshot = await new GitHubProjectsClient(token).fetchProjectSnapshot(projectV2Id)

    const plan = planReconcile(snapshot, links, pendingOps)

    const apply: MirrorApply = {
      projectId,
      credentialId,
      source,
      boardId,
      board: {
        remoteId: snapshot.remoteId,
        title: snapshot.title,
        url: snapshot.url,
        version: snapshot.version,
        // Refreshed on the BOARD link's containerRemoteId every pull (the
        // remote Status field id can change) — see outbox.ts convention.
        statusFieldRemoteId: snapshot.statusFieldRemoteId,
      },
      // Full desired column set from the snapshot — applyMirrorSnapshot
      // reconciles adds/renames/reorders against it.
      columns: snapshot.columns.map(toApplyColumn),
      // Conflicts are deliberately ABSENT from upsertItems.
      upsertItems: [
        ...plan.newItems.map(toApplyItem),
        ...plan.remoteUpdates.map((u) => toApplyItem(u.item)),
      ],
      deleteRemoteIds: plan.remoteDeletes.map((link) => link.remoteId),
    }

    applyMirrorSnapshot(apply)

    // Persist pull-side conflicts so they outlive this pull and make
    // getMirrorStatus.openConflicts real — at most one OPEN row per link
    // (repeated pulls of the same divergence must not pile up duplicates).
    // mutationId stays null: this is a pull-detected conflict, not a push
    // probe; the blocking op (if any) is recorded in localSnapshot.
    for (const conflict of plan.conflicts) {
      const [open] = await db
        .select({ id: syncConflicts.id })
        .from(syncConflicts)
        .where(and(
          eq(syncConflicts.remoteLinkId, conflict.link.id),
          isNull(syncConflicts.resolvedAt),
        ))
        .limit(1)
      if (open !== undefined) continue
      await db.insert(syncConflicts).values({
        id: generateId(),
        projectId,
        remoteLinkId: conflict.link.id,
        mutationId: null,
        // Best-available three-way record: the link's last-agreed state as
        // base, the local identity + blocking op as local, the fresh snapshot
        // item verbatim as remote.
        baseSnapshot: JSON.stringify({
          lastSyncedHash: conflict.link.lastSyncedHash,
          remoteVersion: conflict.link.remoteVersion,
        }),
        localSnapshot: JSON.stringify({
          localType: conflict.link.localType,
          localId: conflict.link.localId,
          pendingOpId: conflict.pendingOpId,
        }),
        remoteSnapshot: JSON.stringify(conflict.item),
      })
    }

    // Stamp lastPulledAt on every link this pull touched (the board link
    // always counts — the pull observed the board even when nothing changed).
    const now = new Date().toISOString()
    const touchedLinkIds = [
      boardLink.id,
      ...plan.remoteUpdates.map((u) => u.link.id),
      ...plan.remoteDeletes.map((link) => link.id),
      ...plan.columnChanges.renamed.map((c) => c.link.id),
    ]
    await db
      .update(remoteLinks)
      .set({ lastPulledAt: now, updatedAt: now })
      .where(inArray(remoteLinks.id, touchedLinkIds))

    const pulled = plan.newItems.length + plan.remoteUpdates.length
    const conflicts = plan.conflicts.length

    await emitMirrorEvent('mirror.pull.completed', projectId, 'board', boardId, {
      credentialId,
      source,
      projectId,
      boardId,
      remoteProjectId: projectV2Id,
      phase: 'pull',
      pulled,
      conflicts,
      deletes: plan.remoteDeletes.length,
    })

    return { pulled, conflicts }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    await emitMirrorEvent('mirror.pull.failed', projectId, 'board', boardId, {
      credentialId,
      source,
      projectId,
      boardId,
      remoteProjectId: projectV2Id,
      phase: 'pull',
      error: errorMessage,
    })
    throw err
  }
}

// ── Status (for the MirrorStatusChip / routes layer) ────────────────────────

/**
 * Sync status summary for a board. A board with no remote link is simply
 * unlinked — never an error (most boards are local-only).
 */
export async function getMirrorStatus(boardId: string): Promise<MirrorStatus> {
  const db = getDb()

  const [boardLink] = await db
    .select()
    .from(remoteLinks)
    .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, boardId)))
    .limit(1)

  if (boardLink === undefined) {
    return {
      linked: false,
      source: null,
      remoteUrl: null,
      lastPulledAt: null,
      pendingPushes: 0,
      openConflicts: 0,
      failedPushes: 0,
    }
  }

  const [credentialRow] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, boardLink.credentialId))
    .limit(1)
  const source = (credentialRow?.source ?? boardLink.source) as IntegrationSource

  // Pending pushes: active mutations whose link is an item on this board.
  // (Creates with remoteLinkId = null cannot be attributed to a board yet and
  // are excluded — Phase 1 only enqueues moves, which always carry a link.)
  const [pushRow] = await db
    .select({ value: count() })
    .from(mutationQueue)
    .innerJoin(remoteLinks, eq(mutationQueue.remoteLinkId, remoteLinks.id))
    .where(and(
      eq(remoteLinks.credentialId, boardLink.credentialId),
      eq(remoteLinks.remoteType, PV2_ITEM_REMOTE_TYPE),
      eq(remoteLinks.containerRemoteId, boardLink.remoteId),
      inArray(mutationQueue.status, [...ACTIVE_PUSH_STATUSES]),
    ))

  // Failed pushes: terminal 'failed' mutations on this board's item links —
  // local changes that never landed remotely (enqueue-time resolution failures
  // and drains that exhausted their retries). Shown by the chip.
  const [failedRow] = await db
    .select({ value: count() })
    .from(mutationQueue)
    .innerJoin(remoteLinks, eq(mutationQueue.remoteLinkId, remoteLinks.id))
    .where(and(
      eq(remoteLinks.credentialId, boardLink.credentialId),
      eq(remoteLinks.remoteType, PV2_ITEM_REMOTE_TYPE),
      eq(remoteLinks.containerRemoteId, boardLink.remoteId),
      eq(mutationQueue.status, 'failed'),
    ))

  // Open conflicts: unresolved sync_conflicts rows on any of this board's links.
  const [conflictRow] = await db
    .select({ value: count() })
    .from(syncConflicts)
    .innerJoin(remoteLinks, eq(syncConflicts.remoteLinkId, remoteLinks.id))
    .where(and(
      eq(remoteLinks.credentialId, boardLink.credentialId),
      eq(remoteLinks.containerRemoteId, boardLink.remoteId),
      isNull(syncConflicts.resolvedAt),
    ))

  return {
    linked: true,
    source,
    remoteUrl: boardLink.remoteUrl,
    lastPulledAt: boardLink.lastPulledAt,
    pendingPushes: pushRow?.value ?? 0,
    openConflicts: conflictRow?.value ?? 0,
    failedPushes: failedRow?.value ?? 0,
  }
}
