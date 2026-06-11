// Durable push outbox — the "git push" half of bidirectional sync.
// Design: docs/architecture/bidirectional-sync.md §"Reconciliation (pull) and outbox (push)".
//
// Local changes apply instantly; this module records them as mutation_queue rows
// (the outbox) and drains them FIFO, single-flight per credential, to the remote
// via the connector write surface. Every state transition emits an append-only
// events row (audit convention).
//
// ── statusFieldRemoteId storage convention (Phase 1, GitHub Projects v2) ──
// A move_item op needs THREE remote ids: the item, the target status OPTION, and
// the single-select status FIELD that owns the options. The first two live on
// remote_links rows naturally; the field id has no row of its own. Convention:
//
//   board        links: remoteId = ProjectV2 node id, `containerRemoteId` =
//                       the Status FIELD remote id (snapshot.statusFieldRemoteId,
//                       may be null when the project has no Status field).
//   board_column links: remoteId = status OPTION id, `containerRemoteId` =
//                       the ProjectV2 node id.
//   board_item   links: remoteId = item id, `containerRemoteId` = the
//                       ProjectV2 node id.
//
// mirror-sync / boards.applyMirrorSnapshot MUST write links this way —
// enqueueBoardItemMove reads the field id back from the BOARD link here to
// build a self-contained move_item op, so the drain worker never has to
// re-fetch project metadata. (Column/item links keeping the ProjectV2 id in
// containerRemoteId is what lets pullMirror scope them per project.)

import {
  getDb,
  boardItems,
  events,
  mutationQueue,
  remoteLinks,
  syncConflicts,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { UnsupportedMutationError } from '../connectors/base'
import { GitHubConnector } from '../connectors/github'
import { JiraConnector } from '../connectors/jira'
import { ConfluenceConnector } from '../connectors/confluence'
import { NotionConnector } from '../connectors/notion'
import { OneDriveConnector } from '../connectors/onedrive'
import { GitHubNotFoundError, GitHubScopeError } from '../connectors/github-projects'
import type { BaseConnector } from '../connectors/base'
import type { IntegrationCredential, MutationQueueRow, RemoteLink } from '@creare/database'
import type {
  ConnectorConfig,
  IntegrationSource,
  MutationEnvelope,
  MutationOp,
  MutationResult,
  RemoteRef,
} from '../types'

// Max delivery attempts before an op is parked as 'failed' (design: "retries
// with backoff, max 5 → failed + notification").
const MAX_ATTEMPTS = 5

// Spacing between consecutive pushes to the SAME credential — GitHub's GraphQL
// secondary limits forbid concurrent mutations per token and throttle content
// writes (~80/min), so the drain is serial with ≥500ms gaps.
const OP_SPACING_MS = 500

// Same construction the read-side sync engine uses (sync-engine.ts).
function buildConnector(source: IntegrationSource, config: ConnectorConfig): BaseConnector {
  switch (source) {
    case 'github':     return new GitHubConnector(config)
    case 'jira':       return new JiraConnector(config)
    case 'confluence': return new ConfluenceConnector(config)
    case 'notion':     return new NotionConnector(config)
    case 'onedrive':   return new OneDriveConnector(config)
  }
}

function connectorConfig(credential: IntegrationCredential, token: string): ConnectorConfig {
  const metadata = (() => {
    try { return JSON.parse(credential.metadata) as Record<string, unknown> }
    catch { return {} }
  })()
  const rawBaseUrl = metadata['baseUrl'] as string | undefined
  return {
    credentialId: credential.id,
    projectId: credential.projectId,
    token,
    ...(rawBaseUrl !== undefined ? { baseUrl: rawBaseUrl } : {}),
    metadata,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type MutationEventType =
  | 'integration.mutation.enqueued'
  | 'integration.mutation.applied'
  | 'integration.mutation.failed'
  | 'integration.mutation.conflict'

function emitMutationEvent(
  type: MutationEventType,
  projectId: string,
  opId: string,
  payload: Record<string, unknown>,
): void {
  getDb()
    .insert(events)
    .values({
      id: generateId(),
      type,
      domain: 'integrations',
      projectId,
      actorType: 'system',
      actorId: null,
      resourceType: 'mutation_queue',
      resourceId: opId,
      payload: JSON.stringify({ opId, ...payload }),
    })
    .run()
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Durably record a local mutation for push. The row IS the source of truth —
 * once inserted, the op survives crashes/restarts and will be delivered by
 * drainMutationQueue. Returns the generated opId (idempotency key).
 */
export async function enqueueMutation(
  envelope: Omit<MutationEnvelope, 'opId'>,
  remoteLinkId: string | null,
): Promise<string> {
  const db = getDb()
  const opId = generateId()

  await db.insert(mutationQueue).values({
    id: generateId(),
    opId,
    projectId: envelope.projectId,
    credentialId: envelope.credentialId,
    source: envelope.source,
    remoteLinkId,
    kind: envelope.op.kind,
    payload: JSON.stringify(envelope.op),
    baseVersion: envelope.baseVersion,
    status: 'pending',
    attempts: 0,
  })

  emitMutationEvent('integration.mutation.enqueued', envelope.projectId, opId, {
    credentialId: envelope.credentialId,
    source: envelope.source,
    kind: envelope.op.kind,
    remoteLinkId,
  })

  return opId
}

/**
 * Boards PATCH hook: a board_item moved to a new column. If the item is
 * mirrored (has a live remote_links row), resolve the remote ids and enqueue a
 * move_item op; if not, return null — plain local boards push nothing.
 *
 * NEVER throws. The route fire-and-forgets this call, so a thrown error would
 * leave NO op row and the local move would be silently reverted by the next
 * remote-wins pull. When the item IS mirrored but a required remote ref cannot
 * be resolved (unmirrored target column, missing board link, or a link
 * violating the containerRemoteId conventions above), a mutation_queue row is
 * still inserted with status 'failed' and a clear lastError: the row records
 * local divergence — the pull reconciler keeps the item a CONFLICT instead of
 * reverting it — and surfaces via getMirrorStatus.failedPushes.
 */
export async function enqueueBoardItemMove(
  boardItemId: string,
  toColumnId: string,
): Promise<string | null> {
  try {
    const db = getDb()

    const itemLink = db
      .select()
      .from(remoteLinks)
      .where(and(
        eq(remoteLinks.localType, 'board_item'),
        eq(remoteLinks.localId, boardItemId),
        isNull(remoteLinks.deletedAt),
      ))
      .get()
    if (itemLink === undefined) return null // board not mirrored — nothing to push

    // From here on the item IS mirrored: every unresolved ref is parked as a
    // failed op instead of thrown — divergence must be tracked, never lost.
    const columnLink = db
      .select()
      .from(remoteLinks)
      .where(and(
        eq(remoteLinks.localType, 'board_column'),
        eq(remoteLinks.localId, toColumnId),
        isNull(remoteLinks.deletedAt),
      ))
      .get()
    if (columnLink === undefined) {
      return await enqueueFailedBoardItemMove(itemLink, boardItemId, toColumnId,
        `target column ${toColumnId} has no remote link`)
    }
    if (itemLink.containerRemoteId === null) {
      return await enqueueFailedBoardItemMove(itemLink, boardItemId, toColumnId,
        `item link ${itemLink.id} is missing containerRemoteId (expected the ProjectV2 node id)`)
    }

    // The Status FIELD id lives on the BOARD link (containerRemoteId — see the
    // convention block above). The item link's containerRemoteId is the ProjectV2
    // node id, which identifies the board link's remoteId.
    const boardLink = db
      .select()
      .from(remoteLinks)
      .where(and(
        eq(remoteLinks.credentialId, itemLink.credentialId),
        eq(remoteLinks.localType, 'board'),
        eq(remoteLinks.remoteId, itemLink.containerRemoteId),
        isNull(remoteLinks.deletedAt),
      ))
      .get()
    if (boardLink === undefined) {
      return await enqueueFailedBoardItemMove(itemLink, boardItemId, toColumnId,
        `no board link found for ProjectV2 ${itemLink.containerRemoteId} (item link ${itemLink.id}) — cannot resolve the status FIELD id`)
    }
    if (boardLink.containerRemoteId === null) {
      return await enqueueFailedBoardItemMove(itemLink, boardItemId, toColumnId,
        `board link ${boardLink.id} is missing containerRemoteId (expected the status FIELD remote id — see outbox.ts convention)`)
    }

    const op: MutationOp = {
      kind: 'move_item',
      ref: {
        remoteType: itemLink.remoteType,
        remoteId: itemLink.remoteId,
        containerId: itemLink.containerRemoteId,
      },
      toStatusRemoteId: columnLink.remoteId,
      statusFieldRemoteId: boardLink.containerRemoteId,
    }

    return await enqueueMutation(
      {
        credentialId: itemLink.credentialId,
        projectId: itemLink.projectId,
        source: itemLink.source as IntegrationSource,
        baseVersion: itemLink.remoteVersion,
        op,
      },
      itemLink.id,
    )
  } catch {
    // Last-resort guard (e.g. the DB write itself failed) — never throw out of
    // the enqueue path. null = "nothing was recorded", matching reality.
    return null
  }
}

// Park a board-item move that cannot be delivered as a 'failed' mutation_queue
// row. The row is terminal (the drain only picks up 'pending') but it (a) marks
// the link as locally diverged so planReconcile reports a CONFLICT instead of
// letting a remote-wins update revert the move, and (b) is counted by
// getMirrorStatus.failedPushes so the chip surfaces it.
async function enqueueFailedBoardItemMove(
  itemLink: RemoteLink,
  boardItemId: string,
  toColumnId: string,
  reason: string,
): Promise<string> {
  const db = getDb()
  const opId = generateId()
  const lastError = `enqueueBoardItemMove: board_item ${boardItemId} is mirrored but ${reason}`

  await db.insert(mutationQueue).values({
    id: generateId(),
    opId,
    projectId: itemLink.projectId,
    credentialId: itemLink.credentialId,
    source: itemLink.source,
    remoteLinkId: itemLink.id,
    kind: 'move_item',
    // NOT a deliverable MutationOp — records the local intent for diagnostics
    // and the conflict UI. The row never reaches a connector ('failed' rows
    // are excluded from the drain query).
    payload: JSON.stringify({ kind: 'move_item', boardItemId, toColumnId }),
    baseVersion: itemLink.remoteVersion,
    status: 'failed',
    attempts: 0,
    lastError,
  })

  emitMutationEvent('integration.mutation.failed', itemLink.projectId, opId, {
    credentialId: itemLink.credentialId,
    source: itemLink.source,
    kind: 'move_item',
    remoteLinkId: itemLink.id,
    attempts: 0,
    error: lastError,
  })

  return opId
}

// ── Card lifecycle enqueue helpers (create / edit / close / comment) ─────────
//
// Same contract as enqueueBoardItemMove: NEVER throw; return the opId, or null
// when the entity is not mirrored (no live remote link) — plain local boards
// push nothing. The routes layer fire-and-forgets-or-awaits these and kicks
// the push worker only on a non-null opId.

// Live (non-tombstoned) remote link for a local entity, or undefined.
function liveLink(localType: RemoteLink['localType'], localId: string): RemoteLink | undefined {
  return getDb()
    .select()
    .from(remoteLinks)
    .where(and(
      eq(remoteLinks.localType, localType),
      eq(remoteLinks.localId, localId),
      isNull(remoteLinks.deletedAt),
    ))
    .get()
}

// RemoteRef for an item link. exactOptionalPropertyTypes: containerId is
// omitted (not set to undefined) when the link has no containerRemoteId.
function itemRefOf(link: RemoteLink): RemoteRef {
  return {
    remoteType: link.remoteType,
    remoteId: link.remoteId,
    ...(link.containerRemoteId !== null ? { containerId: link.containerRemoteId } : {}),
  }
}

// Shared ref-op path: resolve the item's live link, build the op against its
// RemoteRef, enqueue pending. null = item not mirrored (or the DB write itself
// failed — nothing was recorded, matching reality).
async function enqueueItemOp(
  boardItemId: string,
  buildOp: (ref: RemoteRef) => MutationOp,
): Promise<string | null> {
  try {
    const itemLink = liveLink('board_item', boardItemId)
    if (itemLink === undefined) return null // board not mirrored — nothing to push
    return await enqueueMutation(
      {
        credentialId: itemLink.credentialId,
        projectId: itemLink.projectId,
        source: itemLink.source as IntegrationSource,
        baseVersion: itemLink.remoteVersion,
        op: buildOp(itemRefOf(itemLink)),
      },
      itemLink.id,
    )
  } catch {
    return null
  }
}

/** Card edit (title/body) → update_item. Never throws; null = not mirrored. */
export async function enqueueItemUpdate(
  boardItemId: string,
  patch: { title?: string; body?: string },
): Promise<string | null> {
  // Strip absent keys so the durable payload JSON never carries undefined.
  const cleanPatch = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.body !== undefined ? { body: patch.body } : {}),
  }
  return enqueueItemOp(boardItemId, (ref) => ({ kind: 'update_item', ref, patch: cleanPatch }))
}

/** Card close → close_item. Never throws; null = not mirrored. */
export async function enqueueItemClose(boardItemId: string): Promise<string | null> {
  return enqueueItemOp(boardItemId, (ref) => ({ kind: 'close_item', ref }))
}

/** Card comment → comment. Never throws; null = not mirrored. */
export async function enqueueItemComment(boardItemId: string, body: string): Promise<string | null> {
  return enqueueItemOp(boardItemId, (ref) => ({ kind: 'comment', ref, body }))
}

// create_item payload extension: a freshly-created local board_item has NO
// remote_links row yet (that's the point of the op), so the op JSON itself
// carries the local board_item id. processOp reads it back on success and
// upserts the link with the remote id the connector minted — see
// linkCreatedItem below.
type CreateItemOp = Extract<MutationOp, { kind: 'create_item' }>
type CreateItemOpPayload = CreateItemOp & { localBoardItemId: string }

/**
 * Card create on a mirrored board → create_item against the BOARD's container
 * ref (remoteType/remoteId from the board link — the ProjectV2 node id /
 * Jira project / Notion database id). baseVersion is null: nothing exists
 * remotely yet, so there is no merge base and no pre-push conflict probe.
 * Never throws; null = item row missing or board not mirrored.
 */
export async function enqueueItemCreate(
  boardItemId: string,
  title: string,
  body?: string,
): Promise<string | null> {
  try {
    const item = getDb()
      .select()
      .from(boardItems)
      .where(eq(boardItems.id, boardItemId))
      .get()
    if (item === undefined) return null

    const boardLink = liveLink('board', item.boardId)
    if (boardLink === undefined) return null // board not mirrored — nothing to push

    const op: CreateItemOpPayload = {
      kind: 'create_item',
      container: { remoteType: boardLink.remoteType, remoteId: boardLink.remoteId },
      title,
      ...(body !== undefined ? { body } : {}),
      localBoardItemId: boardItemId,
    }
    // remoteLinkId is null — the link does not exist until the push succeeds.
    return await enqueueMutation(
      {
        credentialId: boardLink.credentialId,
        projectId: boardLink.projectId,
        source: boardLink.source as IntegrationSource,
        baseVersion: null,
        op,
      },
      null,
    )
  } catch {
    return null
  }
}

/**
 * Crash recovery: reset every 'in_flight' op back to 'pending'. in_flight is
 * only ever a transient claim held inside a live processOp call — a row still
 * carrying it at boot means a previous session died mid-push, and nothing
 * would ever pick the op up again (the drain only selects 'pending'). The push
 * worker calls this once at startup, BEFORE the first drain. Returns the
 * number of recovered ops.
 */
export async function recoverStaleInFlight(): Promise<number> {
  const result = getDb()
    .update(mutationQueue)
    .set({ status: 'pending', updatedAt: new Date().toISOString() })
    .where(eq(mutationQueue.status, 'in_flight'))
    .run()
  return result.changes
}

// ── Drain ────────────────────────────────────────────────────────────────────

// Credentials currently being drained by THIS process — a second concurrent
// drainMutationQueue call skips them instead of interleaving pushes (which
// would break both FIFO order and the per-credential spacing guarantee).
const drainingCredentials = new Set<string>()

type OpOutcome = 'applied' | 'conflicted' | 'failed' | 'retrying' | 'skipped'

export interface DrainResult { applied: number; conflicts: number; failed: number }

/**
 * Deliver pending ops. FIFO per credential (createdAt, rowid tiebreak),
 * single-flight per credential with ~500ms spacing between pushes; distinct
 * credentials drain concurrently. One attempt per op per drain call — the
 * push worker re-invokes on an interval, which provides the retry backoff.
 *
 * `getCredential` is wired by the caller (desktop main process) and resolves
 * the decrypted token — this package never touches token ciphertext.
 */
export async function drainMutationQueue(
  getCredential: (credentialId: string) => Promise<{ credential: IntegrationCredential; token: string }>,
): Promise<DrainResult> {
  const db = getDb()

  const pending = db
    .select()
    .from(mutationQueue)
    .where(eq(mutationQueue.status, 'pending'))
    .orderBy(asc(mutationQueue.createdAt), asc(sql`rowid`))
    .all()

  // Group by credential, preserving FIFO order within each group.
  const byCredential = new Map<string, MutationQueueRow[]>()
  for (const row of pending) {
    const group = byCredential.get(row.credentialId)
    if (group === undefined) byCredential.set(row.credentialId, [row])
    else group.push(row)
  }

  const counts: DrainResult = { applied: 0, conflicts: 0, failed: 0 }

  await Promise.all(
    [...byCredential.entries()].map(async ([credentialId, ops]) => {
      if (drainingCredentials.has(credentialId)) return // already in flight here
      drainingCredentials.add(credentialId)
      try {
        let pushedAny = false
        for (const row of ops) {
          if (pushedAny) await sleep(OP_SPACING_MS)
          const outcome = await processOp(row, getCredential)
          if (outcome === 'applied') counts.applied += 1
          else if (outcome === 'conflicted') counts.conflicts += 1
          else if (outcome === 'failed') counts.failed += 1
          // A transient failure leaves the op 'pending'; stop draining this
          // credential so the retry happens BEFORE younger ops (FIFO causality).
          if (outcome === 'retrying') break
          if (outcome !== 'skipped') pushedAny = true
        }
      } finally {
        drainingCredentials.delete(credentialId)
      }
    }),
  )

  return counts
}

// Process one op end-to-end. Never throws — every failure mode maps to an
// outcome so one bad op can never abort the drain loop.
async function processOp(
  row: MutationQueueRow,
  getCredential: (credentialId: string) => Promise<{ credential: IntegrationCredential; token: string }>,
): Promise<OpOutcome> {
  const db = getDb()
  const attempts = row.attempts + 1

  // Claim: pending → in_flight. changes === 0 means another worker (or an
  // overlapping drain) already took it — skip without counting.
  const claimed = db
    .update(mutationQueue)
    .set({ status: 'in_flight', attempts, updatedAt: new Date().toISOString() })
    .where(and(eq(mutationQueue.id, row.id), eq(mutationQueue.status, 'pending')))
    .run()
  if (claimed.changes === 0) return 'skipped'

  // Malformed payload is a programming error, not a remote failure — park it
  // immediately instead of burning retries.
  let op: MutationOp
  let createLocalId: string | undefined // create_item payloads carry the local board_item id
  try {
    const parsed = JSON.parse(row.payload) as MutationOp & { localBoardItemId?: unknown }
    op = parsed
    if (typeof parsed.localBoardItemId === 'string') createLocalId = parsed.localBoardItemId
  } catch (err) {
    return markFailed(row, attempts, `Unparseable mutation payload: ${errorMessage(err)}`)
  }

  try {
    const envelope: MutationEnvelope = {
      opId: row.opId,
      credentialId: row.credentialId,
      projectId: row.projectId,
      source: row.source as IntegrationSource,
      baseVersion: row.baseVersion,
      op,
    }

    const { credential, token } = await getCredential(row.credentialId)
    const connector = buildConnector(envelope.source, connectorConfig(credential, token))

    // Pre-push conflict probe. move_item is last-write-wins per design: push
    // regardless, but record overwroteRemote when the remote drifted off base.
    let overwroteRemote = false
    const ref: RemoteRef | null = 'ref' in op ? op.ref : null
    if (row.baseVersion !== null && ref !== null) {
      const remoteVersion = await connector.fetchRemoteVersion(ref)
      const drifted = remoteVersion !== null && remoteVersion !== row.baseVersion
      if (drifted) {
        if (op.kind === 'move_item') {
          overwroteRemote = true
        } else {
          return markConflicted(row, op, remoteVersion)
        }
      }
    }

    const result = await connector.applyMutation(envelope)
    const now = new Date().toISOString()

    db.update(mutationQueue)
      .set({
        status: 'applied',
        result: JSON.stringify(result),
        lastError: null,
        appliedAt: now,
        updatedAt: now,
      })
      .where(eq(mutationQueue.id, row.id))
      .run()

    // Push succeeded → the remote's new version is our new merge base.
    if (row.remoteLinkId !== null) {
      db.update(remoteLinks)
        .set({ remoteVersion: result.remoteVersion, lastPushedAt: now, updatedAt: now })
        .where(eq(remoteLinks.id, row.remoteLinkId))
        .run()
    }

    // create_item success: the connector minted a brand-new remote object
    // (MutationResult.ref). UPSERT the board_item's remote link with that id
    // so future move/edit/pull resolve the item. Guarded: the op WAS applied
    // remotely — a link-write failure must never flow into the catch below
    // and resurrect the op (a retry would create a duplicate remote item).
    if (op.kind === 'create_item' && createLocalId !== undefined) {
      try {
        linkCreatedItem(row, op.container, result, createLocalId, now)
      } catch {
        // Link lost, push applied — the next pull re-links via the remote upsert path.
      }
    }

    emitMutationEvent('integration.mutation.applied', row.projectId, row.opId, {
      kind: op.kind,
      credentialId: row.credentialId,
      remoteVersion: result.remoteVersion,
      overwroteRemote,
    })
    return 'applied'
  } catch (err) {
    const message = errorMessage(err)

    if (isFatalPushError(err) || attempts >= MAX_ATTEMPTS) {
      return markFailed(row, attempts, message, op.kind)
    }

    // Transient: release back to pending for the next drain pass.
    db.update(mutationQueue)
      .set({ status: 'pending', lastError: message, updatedAt: new Date().toISOString() })
      .where(eq(mutationQueue.id, row.id))
      .run()
    return 'retrying'
  }
}

// Bind a freshly-pushed create_item result to its local board_item.
// remote_links has a UNIQUE(localType, localId) index, so at most one row can
// exist (live OR tombstoned) — e.g. a pull that ran mid-flight may already
// have linked the item, or a prior remove left a tombstone. UPSERT: update
// that row in place, else insert a new one. Link conventions (see the header
// block): item links carry the board's remote id in containerRemoteId.
function linkCreatedItem(
  row: MutationQueueRow,
  container: RemoteRef,
  result: MutationResult,
  boardItemId: string,
  now: string,
): void {
  const db = getDb()
  const existing = db
    .select()
    .from(remoteLinks)
    .where(and(
      eq(remoteLinks.localType, 'board_item'),
      eq(remoteLinks.localId, boardItemId),
    ))
    .get()
  const containerRemoteId = result.ref.containerId ?? container.remoteId

  if (existing !== undefined) {
    db.update(remoteLinks)
      .set({
        remoteType: result.ref.remoteType,
        remoteId: result.ref.remoteId,
        containerRemoteId,
        remoteUrl: result.remoteUrl ?? existing.remoteUrl,
        remoteVersion: result.remoteVersion,
        lastPushedAt: now,
        deletedAt: null,
        updatedAt: now,
      })
      .where(eq(remoteLinks.id, existing.id))
      .run()
  } else {
    db.insert(remoteLinks)
      .values({
        id: generateId(),
        projectId: row.projectId,
        credentialId: row.credentialId,
        source: row.source,
        localType: 'board_item',
        localId: boardItemId,
        remoteType: result.ref.remoteType,
        remoteId: result.ref.remoteId,
        containerRemoteId,
        remoteUrl: result.remoteUrl ?? null,
        remoteVersion: result.remoteVersion,
        lastPushedAt: now,
      })
      .run()
  }
}

function markFailed(row: MutationQueueRow, attempts: number, message: string, kind?: string): OpOutcome {
  getDb()
    .update(mutationQueue)
    .set({ status: 'failed', lastError: message, updatedAt: new Date().toISOString() })
    .where(eq(mutationQueue.id, row.id))
    .run()
  emitMutationEvent('integration.mutation.failed', row.projectId, row.opId, {
    kind: kind ?? row.kind,
    credentialId: row.credentialId,
    attempts,
    error: message,
  })
  return 'failed'
}

function markConflicted(row: MutationQueueRow, op: MutationOp, remoteVersion: string | null): OpOutcome {
  const db = getDb()
  db.update(mutationQueue)
    .set({ status: 'conflicted', updatedAt: new Date().toISOString() })
    .where(eq(mutationQueue.id, row.id))
    .run()

  // sync_conflicts requires a link; ops without one (creates) can't reach this
  // branch in practice, but guard anyway — the status transition still happens.
  if (row.remoteLinkId !== null) {
    db.insert(syncConflicts)
      .values({
        id: generateId(),
        projectId: row.projectId,
        remoteLinkId: row.remoteLinkId,
        mutationId: row.id,
        baseSnapshot: JSON.stringify({ version: row.baseVersion }),
        localSnapshot: JSON.stringify({ op }),
        remoteSnapshot: JSON.stringify({ version: remoteVersion }),
      })
      .run()
  }

  emitMutationEvent('integration.mutation.conflict', row.projectId, row.opId, {
    kind: op.kind,
    credentialId: row.credentialId,
    baseVersion: row.baseVersion,
    remoteVersion,
  })
  return 'conflicted'
}

// Fatal = retrying cannot help: capability mismatch, missing scope/permission,
// or the remote object is gone. Everything else is treated as transient.
function isFatalPushError(err: unknown): boolean {
  if (err instanceof UnsupportedMutationError) return true
  if (err instanceof GitHubScopeError) return true
  if (err instanceof GitHubNotFoundError) return true
  // BaseConnector.fetchWithRetry throws plain Errors for auth failures.
  if (err instanceof Error && /\bHTTP 40[13]\b/.test(err.message)) return true
  return false
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
