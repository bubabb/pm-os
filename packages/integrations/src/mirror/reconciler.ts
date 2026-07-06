// Three-way pull reconciliation planner — PURE (no DB, no IO, no clock).
// Design: docs/architecture/bidirectional-sync.md §"Reconciliation (pull) and outbox (push)".
//
// Given a fresh remote snapshot, the existing remote_links rows, and the
// outstanding mutation queue, planReconcile computes WHAT should change locally.
// It never applies anything — boards.applyMirrorSnapshot() consumes the plan and
// performs all local writes in one transaction.
//
// Three-way merge inputs per item:
//   base   = link.lastSyncedHash   (hash of the last state both sides agreed on)
//   remote = item.contentHash      (hash of the snapshot item, computed by the connector)
//   local  = signaled by an UNRESOLVED mutation targeting the item's link
//
// Scope note (deliberate): local divergence is detected ONLY via outstanding
// ops. An unresolved mutation on a link is the signal that local moved off
// base; deeper local-vs-base diffing requires reading local rows and therefore
// lives in the impure caller, not in this pure function.
//
// Determinism: outputs preserve input order — newItems/remoteUpdates/conflicts
// and columnChanges follow snapshot order; remoteDeletes follow `links` order.

import { stableHash } from '@pm-os/shared'
import type { RemoteLink, MutationQueueRow } from '@pm-os/database'
import type { MirrorBoardSnapshot, MirrorColumnSnapshot, MirrorItemSnapshot } from '../types'

// remote_links.remoteType discriminators for GitHub Projects v2 mirrors
export const PV2_ITEM_REMOTE_TYPE = 'pv2_item'
export const PV2_STATUS_OPTION_REMOTE_TYPE = 'pv2_status_option'

// Mutation statuses that mean "local has an unsynced change". pending/in_flight
// are waiting to be pushed; failed and conflicted ops ALSO represent local
// divergence — the local edit never landed remotely, so a remote-wins update
// would silently revert it. Only applied/cancelled ops stop counting.
// Exported so impure callers (mirror-sync's pull query) stay in lockstep.
export const UNRESOLVED_OP_STATUSES = ['pending', 'in_flight', 'failed', 'conflicted'] as const
const ACTIVE_OP_STATUSES: ReadonlySet<string> = new Set(UNRESOLVED_OP_STATUSES)

export interface ReconcilePlan {
  /** Remote item with no LIVE link (none at all, or only a tombstone) → create/resurrect locally. */
  newItems: MirrorItemSnapshot[]
  /** Remote changed, no local divergence signal → safe to apply remote→local. */
  remoteUpdates: Array<{ link: RemoteLink; item: MirrorItemSnapshot }>
  /** Remote changed AND an unresolved op targets the link → both sides moved. */
  conflicts: Array<{ link: RemoteLink; item: MirrorItemSnapshot; pendingOpId: string | null }>
  /** Linked item missing from the snapshot or archived remotely → archive local + tombstone link. */
  remoteDeletes: RemoteLink[]
  /** Status-option (column) changes: brand-new columns and name/position drift. */
  columnChanges: {
    added: MirrorColumnSnapshot[]
    renamed: Array<{ link: RemoteLink; name: string; position: number }>
  }
}

/**
 * Canonical sync hash for a column link. Columns carry no contentHash in the
 * snapshot, so the reconciler and applyMirrorSnapshot must agree on one
 * encoding: applyMirrorSnapshot stores this value in link.lastSyncedHash when
 * it writes a column, and planReconcile compares against it to detect renames
 * and reorders. Only name + position participate — they are the only column
 * attributes mirrored locally.
 */
export function columnSyncHash(column: Pick<MirrorColumnSnapshot, 'name' | 'position'>): string {
  return stableHash({ name: column.name, position: column.position })
}

/**
 * Plan the local writes needed to reconcile a remote board snapshot against
 * the existing links and the outbound mutation queue. Pure and deterministic:
 * same inputs → same plan, no side effects.
 */
export function planReconcile(
  snapshot: MirrorBoardSnapshot,
  links: RemoteLink[],
  pendingOps: MutationQueueRow[],
): ReconcilePlan {
  // --- Index links by (remoteType, remoteId) ---------------------------------
  const itemLinks = new Map<string, RemoteLink>()
  const columnLinks = new Map<string, RemoteLink>()
  for (const link of links) {
    if (link.remoteType === PV2_ITEM_REMOTE_TYPE) {
      // Tombstoned item links are deliberately NOT indexed as live. An item
      // that is alive in the snapshot but only matches a tombstone (remotely
      // un-archived, or deleted locally while still present remotely) must be
      // treated as MISSING so it lands in newItems and the boards resurrect
      // path revives it — indexing the tombstone would make the hash
      // comparison skip it forever.
      if (link.deletedAt === null) itemLinks.set(link.remoteId, link)
    } else if (link.remoteType === PV2_STATUS_OPTION_REMOTE_TYPE) {
      columnLinks.set(link.remoteId, link)
    }
  }

  // --- Index active ops by the link they target ------------------------------
  // First active op per link wins (queue order = createdAt drain order upstream).
  const activeOpByLinkId = new Map<string, MutationQueueRow>()
  for (const op of pendingOps) {
    if (op.remoteLinkId === null) continue // creates — no link yet, nothing to collide with
    if (!ACTIVE_OP_STATUSES.has(op.status)) continue
    if (!activeOpByLinkId.has(op.remoteLinkId)) activeOpByLinkId.set(op.remoteLinkId, op)
  }

  const plan: ReconcilePlan = {
    newItems: [],
    remoteUpdates: [],
    conflicts: [],
    remoteDeletes: [],
    columnChanges: { added: [], renamed: [] },
  }

  // --- Items ------------------------------------------------------------------
  // remoteIds that are alive in the snapshot — linked ids NOT in this set are
  // remote deletes. Archived items are deliberately excluded: a linked-but-
  // archived item is a remote delete; an unlinked archived item is ignored.
  const liveItemRemoteIds = new Set<string>()
  for (const item of snapshot.items) {
    if (item.archived) continue
    liveItemRemoteIds.add(item.remoteId)
    const link = itemLinks.get(item.remoteId)

    if (link === undefined) {
      plan.newItems.push(item)
      continue
    }
    if (item.contentHash === link.lastSyncedHash) continue // unchanged since base — skip

    // Remote moved off base. A never-synced link (lastSyncedHash null) also
    // lands here: applying remote state is the correct, idempotent catch-up.
    const op = activeOpByLinkId.get(link.id)
    if (op !== undefined) {
      plan.conflicts.push({ link, item, pendingOpId: op.opId })
    } else {
      plan.remoteUpdates.push({ link, item })
    }
  }

  // --- Remote deletes: linked items gone or archived remotely ------------------
  // Tombstoned links (deletedAt set) are skipped so repeated pulls stay idempotent.
  for (const link of links) {
    if (link.remoteType !== PV2_ITEM_REMOTE_TYPE) continue
    if (link.deletedAt !== null) continue
    if (!liveItemRemoteIds.has(link.remoteId)) plan.remoteDeletes.push(link)
  }

  // --- Columns ------------------------------------------------------------------
  for (const column of snapshot.columns) {
    const link = columnLinks.get(column.remoteId)
    if (link === undefined) {
      plan.columnChanges.added.push(column)
      continue
    }
    if (columnSyncHash(column) !== link.lastSyncedHash) {
      plan.columnChanges.renamed.push({ link, name: column.name, position: column.position })
    }
  }

  return plan
}
