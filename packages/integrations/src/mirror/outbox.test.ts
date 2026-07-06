import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, seedTask, destroyTestDb } from '@creare/database/testing'
import {
  getDb,
  boards,
  boardColumns,
  boardItems,
  events,
  integrationCredentials,
  mutationQueue,
  remoteLinks,
  syncConflicts,
  tasks,
} from '@creare/database'
import { generateId, stableHash } from '@creare/shared'
import { and, eq } from 'drizzle-orm'
import { UnsupportedMutationError } from '../connectors/base'
import {
  enqueueMutation,
  enqueueBoardItemMove,
  enqueueItemCreate,
  enqueueItemUpdate,
  enqueueItemClose,
  enqueueItemComment,
  drainMutationQueue,
  recoverStaleInFlight,
} from './outbox'
import { planReconcile } from './reconciler'
import type { IntegrationCredential } from '@creare/database'
import type { MirrorItemSnapshot, MutationEnvelope, MutationOp } from '../types'

// Stub the GitHub connector — the drain must never hit the network in tests.
// outbox.ts builds connectors itself (buildConnector pattern), so the module
// is replaced wholesale, mirroring sync-engine.test.ts.
const stub = vi.hoisted(() => ({
  applyError: null as Error | null,
  failCreate: false, // when true, create_item throws a FATAL (no-retry) error
  remoteVersion: null as string | null,
  applied: [] as Array<{ opId: string; kind: string }>,
  // create-finalize re-fetch (fetchItemSnapshot) controls:
  snapshotError: null as Error | null,        // when set, fetchItemSnapshot throws it
  snapshotOverride: null as MirrorItemSnapshot | null, // when set, returned verbatim
  snapshotReturnsNull: false,                 // when true, fetchItemSnapshot returns null (item not found)
  lastCreatedTitle: null as string | null,    // title of the most recent create, for the default snapshot
  snapshotCalls: [] as string[],              // remoteIds fetchItemSnapshot was called with
}))
vi.mock('../connectors/github', () => ({
  GitHubConnector: class {
    constructor(_config: unknown) {}
    async applyMutation(envelope: MutationEnvelope) {
      // HTTP 403 is fatal per isFatalPushError — simulates a create that can
      // never succeed (referencing the imported error class inside this hoisted
      // factory is unsafe, so use the message form).
      if (stub.failCreate && envelope.op.kind === 'create_item') {
        throw new Error('HTTP 403 from https://api.github.com/graphql')
      }
      if (stub.applyError) throw stub.applyError
      stub.applied.push({ opId: envelope.opId, kind: envelope.op.kind })
      const base = { ref: { remoteType: 'pv2_item', remoteId: 'ITEM_1', containerId: 'PVT_board1' }, remoteVersion: 'v2', raw: {} }
      // A create returns the pull-equivalent baseline of the new draft (kept only
      // as a FALLBACK now — the live baseline comes from fetchItemSnapshot).
      if (envelope.op.kind === 'create_item') {
        stub.lastCreatedTitle = envelope.op.title
        return {
          ...base,
          createdBaseline: {
            remoteId: 'ITEM_1',
            title: envelope.op.title,
            statusRemoteId: null,
            state: 'draft' as const,
            archived: false,
          },
        }
      }
      return base
    }
    async fetchRemoteVersion(_ref: unknown) {
      return stub.remoteVersion
    }
    // Single-item re-fetch the outbox create-finalize uses to stamp lastSyncedHash.
    async fetchItemSnapshot(ref: { remoteId: string; containerId?: string }): Promise<MirrorItemSnapshot | null> {
      stub.snapshotCalls.push(ref.remoteId)
      if (stub.snapshotError) throw stub.snapshotError
      if (stub.snapshotReturnsNull) return null
      if (stub.snapshotOverride) return stub.snapshotOverride
      // Default: mirror the just-created draft exactly as a real pull would —
      // no status, state 'draft', not archived.
      const title = stub.lastCreatedTitle ?? 'New card'
      return {
        remoteId: ref.remoteId,
        containerRemoteId: ref.containerId ?? 'PVT_board1',
        title,
        url: null,
        statusRemoteId: null,
        state: 'draft',
        archived: false,
        version: 'v2',
        contentHash: stableHash({ title, statusRemoteId: null, state: 'draft', archived: false }),
      }
    }
  },
}))

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId, 'github')
  stub.applyError = null
  stub.failCreate = false
  stub.remoteVersion = null
  stub.applied = []
  stub.snapshotError = null
  stub.snapshotOverride = null
  stub.snapshotReturnsNull = false
  stub.lastCreatedTitle = null
  stub.snapshotCalls = []
})
afterEach(() => destroyTestDb())

// ── Fixtures ─────────────────────────────────────────────────────────────────

function seedLink(overrides: {
  localType: 'board' | 'board_column' | 'board_item' | 'task'
  localId: string
  remoteType: string
  remoteId: string
  containerRemoteId?: string | null
  remoteVersion?: string | null
}): string {
  const id = generateId()
  getDb()
    .insert(remoteLinks)
    .values({
      id,
      projectId,
      credentialId,
      source: 'github',
      localType: overrides.localType,
      localId: overrides.localId,
      remoteType: overrides.remoteType,
      remoteId: overrides.remoteId,
      containerRemoteId: overrides.containerRemoteId ?? null,
      remoteVersion: overrides.remoteVersion ?? null,
    })
    .run()
  return id
}

// Board + item + column links following the outbox.ts containerRemoteId
// convention: the board link carries the Status FIELD id; item and column
// links carry the ProjectV2 node id.
function seedBoardLink(): string {
  return seedLink({
    localType: 'board', localId: 'board-1',
    remoteType: 'pv2_project', remoteId: 'PVT_board1',
    containerRemoteId: 'FIELD_STATUS',
  })
}

function seedMirroredMove(itemLocalId = 'bi-1'): { itemLinkId: string; columnLinkId: string; boardLinkId: string } {
  const boardLinkId = seedBoardLink()
  const itemLinkId = seedLink({
    localType: 'board_item', localId: itemLocalId,
    remoteType: 'pv2_item', remoteId: `ITEM_${itemLocalId}`,
    containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
  })
  const columnLinkId = seedLink({
    localType: 'board_column', localId: 'col-done',
    remoteType: 'pv2_status_option', remoteId: 'OPT_DONE',
    containerRemoteId: 'PVT_board1',
  })
  return { itemLinkId, columnLinkId, boardLinkId }
}

function moveOp(): MutationOp {
  return {
    kind: 'move_item',
    ref: { remoteType: 'pv2_item', remoteId: 'ITEM_1', containerId: 'PVT_board1' },
    toStatusRemoteId: 'OPT_DONE',
    statusFieldRemoteId: 'FIELD_STATUS',
  }
}

// Real boards/board_columns/tasks/board_items rows — the test DB enforces FKs,
// and enqueueItemCreate reads board_items to resolve the owning board.
function seedRealBoardItem(boardId = 'board-1', itemId = 'bi-new'): string {
  const db = getDb()
  db.insert(boards).values({ id: boardId, projectId, name: 'Mirrored board' }).run()
  db.insert(boardColumns).values({ id: `${boardId}-col0`, boardId, name: 'To Do', position: 0 }).run()
  const taskId = seedTask(projectId)
  db.insert(boardItems).values({ id: itemId, boardId, columnId: `${boardId}-col0`, taskId }).run()
  return itemId
}

function itemLinkRows(localId: string) {
  return getDb().select().from(remoteLinks)
    .where(and(eq(remoteLinks.localType, 'board_item'), eq(remoteLinks.localId, localId)))
    .all()
}

const getCred = async (id: string): Promise<{ credential: IntegrationCredential; token: string }> => {
  const cred = getDb().select().from(integrationCredentials).where(eq(integrationCredentials.id, id)).get()!
  return { credential: cred, token: 'tok' }
}

function queueRow(opId: string) {
  return getDb().select().from(mutationQueue).where(eq(mutationQueue.opId, opId)).get()!
}

function eventsOfType(type: string) {
  return getDb().select().from(events).where(and(eq(events.type, type), eq(events.projectId, projectId))).all()
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('outbox — enqueueMutation', () => {
  it('inserts a durable pending row and emits integration.mutation.enqueued', async () => {
    const linkId = seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', remoteVersion: 'v1',
    })

    const opId = await enqueueMutation(
      { credentialId, projectId, source: 'github', baseVersion: 'v1', op: moveOp() },
      linkId,
    )

    const row = queueRow(opId)
    expect(row.status).toBe('pending')
    expect(row.kind).toBe('move_item')
    expect(row.attempts).toBe(0)
    expect(row.baseVersion).toBe('v1')
    expect(row.remoteLinkId).toBe(linkId)
    expect(JSON.parse(row.payload)).toEqual(moveOp())

    const enqueued = eventsOfType('integration.mutation.enqueued')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.resourceId).toBe(opId)
    expect(JSON.parse(enqueued[0]!.payload)).toMatchObject({ opId, kind: 'move_item' })
  })
})

describe('outbox — enqueueBoardItemMove', () => {
  it('returns null when the board item has no remote link (board not mirrored)', async () => {
    expect(await enqueueBoardItemMove('bi-unlinked', 'col-1')).toBeNull()
    expect(getDb().select().from(mutationQueue).all()).toHaveLength(0)
  })

  it('resolves the item + column + board links into a self-contained move_item op', async () => {
    const { itemLinkId } = seedMirroredMove('bi-1')

    const opId = await enqueueBoardItemMove('bi-1', 'col-done')
    expect(opId).not.toBeNull()

    const row = queueRow(opId!)
    expect(row.remoteLinkId).toBe(itemLinkId)
    expect(row.baseVersion).toBe('v1') // item link's remoteVersion
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'move_item',
      ref: { remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', containerId: 'PVT_board1' },
      toStatusRemoteId: 'OPT_DONE',
      statusFieldRemoteId: 'FIELD_STATUS', // read from the BOARD link's containerRemoteId
    })
  })

  it('never throws: mirrored item + unlinked target column parks a failed op instead', async () => {
    const itemLinkId = seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1',
      containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
    })

    const opId = await enqueueBoardItemMove('bi-1', 'col-unlinked')

    // Divergence is tracked: a 'failed' row exists (so planReconcile keeps the
    // item a CONFLICT) instead of an exception the route would swallow.
    expect(opId).not.toBeNull()
    const row = queueRow(opId!)
    expect(row.status).toBe('failed')
    expect(row.remoteLinkId).toBe(itemLinkId)
    expect(row.baseVersion).toBe('v1')
    expect(row.lastError).toContain('col-unlinked')
    expect(row.lastError).toContain('no remote link')
    expect(eventsOfType('integration.mutation.failed')).toHaveLength(1)

    // A failed row is terminal — the drain never picks it up.
    const counts = await drainMutationQueue(getCred)
    expect(counts).toEqual({ applied: 0, conflicts: 0, failed: 0 })
    expect(stub.applied).toHaveLength(0)
  })

  it('never throws: missing board link (no status FIELD id source) parks a failed op', async () => {
    // Item + column links exist, but the board link is absent entirely.
    seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1',
      containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
    })
    seedLink({
      localType: 'board_column', localId: 'col-done',
      remoteType: 'pv2_status_option', remoteId: 'OPT_DONE', containerRemoteId: 'PVT_board1',
    })

    const opId = await enqueueBoardItemMove('bi-1', 'col-done')

    expect(opId).not.toBeNull()
    const row = queueRow(opId!)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('status FIELD')
  })

  it('never throws: board link without containerRemoteId (null statusField) parks a failed op', async () => {
    seedLink({
      localType: 'board', localId: 'board-1',
      remoteType: 'pv2_project', remoteId: 'PVT_board1',
      containerRemoteId: null, // project has no Status field
    })
    seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1',
      containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
    })
    seedLink({
      localType: 'board_column', localId: 'col-done',
      remoteType: 'pv2_status_option', remoteId: 'OPT_DONE', containerRemoteId: 'PVT_board1',
    })

    const opId = await enqueueBoardItemMove('bi-1', 'col-done')

    expect(opId).not.toBeNull()
    const row = queueRow(opId!)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain('missing containerRemoteId')
  })
})

describe('outbox — enqueueItemUpdate / enqueueItemClose / enqueueItemComment', () => {
  it('return null when the item has no remote link (board not mirrored)', async () => {
    expect(await enqueueItemUpdate('bi-unlinked', { title: 'T' })).toBeNull()
    expect(await enqueueItemClose('bi-unlinked')).toBeNull()
    expect(await enqueueItemComment('bi-unlinked', 'hi')).toBeNull()
    expect(getDb().select().from(mutationQueue).all()).toHaveLength(0)
  })

  it('enqueueItemUpdate enqueues update_item with the item ref, clean patch, and merge base', async () => {
    const { itemLinkId } = seedMirroredMove('bi-1')

    const opId = await enqueueItemUpdate('bi-1', { title: 'Renamed' })
    expect(opId).not.toBeNull()

    const row = queueRow(opId!)
    expect(row.status).toBe('pending')
    expect(row.kind).toBe('update_item')
    expect(row.remoteLinkId).toBe(itemLinkId)
    expect(row.baseVersion).toBe('v1') // item link's remoteVersion
    // toEqual is strict: no `body` key may leak into the durable payload.
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'update_item',
      ref: { remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', containerId: 'PVT_board1' },
      patch: { title: 'Renamed' },
    })
    expect(eventsOfType('integration.mutation.enqueued')).toHaveLength(1)
  })

  it('enqueueItemClose enqueues close_item against the item ref', async () => {
    const { itemLinkId } = seedMirroredMove('bi-1')

    const opId = await enqueueItemClose('bi-1')
    expect(opId).not.toBeNull()

    const row = queueRow(opId!)
    expect(row.kind).toBe('close_item')
    expect(row.remoteLinkId).toBe(itemLinkId)
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'close_item',
      ref: { remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', containerId: 'PVT_board1' },
    })
  })

  it('enqueueItemComment enqueues comment carrying the body', async () => {
    seedMirroredMove('bi-1')

    const opId = await enqueueItemComment('bi-1', 'Looks good to me')
    expect(opId).not.toBeNull()

    const row = queueRow(opId!)
    expect(row.kind).toBe('comment')
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'comment',
      ref: { remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', containerId: 'PVT_board1' },
      body: 'Looks good to me',
    })
  })
})

describe('outbox — enqueueItemCreate + create-result linking', () => {
  it('returns null when the board_item row does not exist', async () => {
    expect(await enqueueItemCreate('bi-ghost', 'Title')).toBeNull()
    expect(getDb().select().from(mutationQueue).all()).toHaveLength(0)
  })

  it('returns null when the board is not mirrored (no board link)', async () => {
    seedRealBoardItem('board-1', 'bi-new') // real rows, but NO remote link
    expect(await enqueueItemCreate('bi-new', 'Title')).toBeNull()
    expect(getDb().select().from(mutationQueue).all()).toHaveLength(0)
  })

  it('enqueues create_item against the board container, payload carrying the local board_item id', async () => {
    seedBoardLink() // board-1 ↔ PVT_board1
    seedRealBoardItem('board-1', 'bi-new')

    const opId = await enqueueItemCreate('bi-new', 'New card', 'card body')
    expect(opId).not.toBeNull()

    const row = queueRow(opId!)
    expect(row.status).toBe('pending')
    expect(row.kind).toBe('create_item')
    expect(row.remoteLinkId).toBeNull() // no link until the push succeeds
    expect(row.baseVersion).toBeNull()  // nothing exists remotely — no merge base
    expect(JSON.parse(row.payload)).toEqual({
      kind: 'create_item',
      container: { remoteType: 'pv2_project', remoteId: 'PVT_board1' },
      title: 'New card',
      body: 'card body',
      localBoardItemId: 'bi-new', // processOp links the minted remote id back via this
    })
  })

  it('on push success, upserts the board_item remote link from MutationResult.ref', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new')
    const opId = (await enqueueItemCreate('bi-new', 'New card'))!

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 1, conflicts: 0, failed: 0 })
    expect(queueRow(opId).status).toBe('applied')

    // The connector stub minted ITEM_1 @ v2 — the item is now linked so
    // future move/edit/pull resolve it.
    const links = itemLinkRows('bi-new')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      credentialId,
      source: 'github',
      remoteType: 'pv2_item',
      remoteId: 'ITEM_1',
      remoteVersion: 'v2',
      containerRemoteId: 'PVT_board1', // item-link convention: the board's remote id
      deletedAt: null,
    })
    expect(links[0]!.lastPushedAt).toBeTruthy()

    // Lifecycle continuity: an edit enqueued AFTER the create push resolves.
    const updateOpId = await enqueueItemUpdate('bi-new', { title: 'Edited' })
    expect(updateOpId).not.toBeNull()
    expect(queueRow(updateOpId!).baseVersion).toBe('v2')
  })

  it('updates an existing link in place instead of duplicating (pull linked the item mid-flight)', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new')
    const staleLinkId = seedLink({
      localType: 'board_item', localId: 'bi-new',
      remoteType: 'pv2_item', remoteId: 'ITEM_stale',
      containerRemoteId: 'PVT_board1', remoteVersion: 'v0',
    })
    // Enqueue bypassing the not-yet-linked guard: simulates a create op that
    // was pending when a pull (or another worker) linked the item.
    const op = {
      kind: 'create_item' as const,
      container: { remoteType: 'pv2_project', remoteId: 'PVT_board1' },
      title: 'New card',
      localBoardItemId: 'bi-new',
    }
    const opId = await enqueueMutation(
      { credentialId, projectId, source: 'github', baseVersion: null, op },
      null,
    )

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 1, conflicts: 0, failed: 0 })
    expect(queueRow(opId).status).toBe('applied')
    const links = itemLinkRows('bi-new')
    expect(links).toHaveLength(1) // UNIQUE(localType, localId) respected — updated, not duplicated
    expect(links[0]!.id).toBe(staleLinkId)
    expect(links[0]).toMatchObject({ remoteId: 'ITEM_1', remoteVersion: 'v2' })
  })
})

describe('outbox — create baseline hash (fixes the forever-revert)', () => {
  it('a GitHub draft create stamps a baseline hash so the next reconcile sees NO change', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new')

    await enqueueItemCreate('bi-new', 'New card')
    const counts = await drainMutationQueue(getCred)
    expect(counts).toMatchObject({ applied: 1 })

    const link = itemLinkRows('bi-new')[0]!
    // Baseline stamped from the connector-RETURNED fields, never a hardcoded guess.
    expect(link.lastSyncedHash).not.toBeNull()

    // The pull recomputes an item's contentHash the SAME way for a GitHub draft:
    // stableHash({ title, statusRemoteId:null, state:'draft', archived:false }).
    const pullContentHash = stableHash({
      title: 'New card', statusRemoteId: null, state: 'draft', archived: false,
    })
    expect(link.lastSyncedHash).toBe(pullContentHash)

    const snapshotItem: MirrorItemSnapshot = {
      remoteId: link.remoteId, // ITEM_1
      containerRemoteId: 'PVT_board1',
      title: 'New card',
      url: null,
      statusRemoteId: null,
      state: 'draft',
      archived: false,
      version: 'v2',
      contentHash: pullContentHash,
    }
    const plan = planReconcile(
      {
        remoteId: 'PVT_board1', title: 'B', url: null, version: 'v2',
        statusFieldRemoteId: 'FIELD_STATUS', columns: [], items: [snapshotItem],
      },
      [link],
      [],
    )
    // The freshly created draft is NOT reclassified as a remoteUpdate (revert)
    // or a conflict — it is unchanged since the baseline.
    expect(plan.remoteUpdates).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.newItems).toHaveLength(0)
  })
})

describe('outbox — baseline from a real re-fetch (auto-status: no churn)', () => {
  it('stamps lastSyncedHash from fetchItemSnapshot so a platform-assigned status yields NO remoteUpdate', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new') // backing task titled 'Test Task'

    // The platform AUTO-ASSIGNS a status on create — the create response never
    // saw it, but the re-fetch (fetchItemSnapshot) computes the item's REAL
    // post-create state exactly as the next pull will.
    const autoContentHash = stableHash({ title: 'Test Task', statusRemoteId: 'opt-todo', state: 'open', archived: false })
    stub.snapshotOverride = {
      remoteId: 'ITEM_1', containerRemoteId: 'PVT_board1',
      title: 'Test Task', url: null, statusRemoteId: 'opt-todo',
      state: 'open', archived: false, version: 'v2', contentHash: autoContentHash,
    }

    // Title matches the backing task → no create-time divergence noise.
    await enqueueItemCreate('bi-new', 'Test Task')
    const counts = await drainMutationQueue(getCred)
    expect(counts).toMatchObject({ applied: 1 })

    // The baseline came from the re-fetch (called once with the minted id), NOT
    // the connector's guessed createdBaseline (which had statusRemoteId null).
    expect(stub.snapshotCalls).toEqual(['ITEM_1'])
    const link = itemLinkRows('bi-new')[0]!
    expect(link.lastSyncedHash).toBe(autoContentHash)
    expect(link.lastSyncedHash).not.toBe(
      stableHash({ title: 'Test Task', statusRemoteId: null, state: 'draft', archived: false }),
    )

    // The very next pull sees the auto-status item exactly as the baseline →
    // NO redundant remoteUpdate (the churn a guessed baseline caused is gone).
    const snapshotItem: MirrorItemSnapshot = {
      remoteId: link.remoteId, containerRemoteId: 'PVT_board1',
      title: 'Test Task', url: null, statusRemoteId: 'opt-todo',
      state: 'open', archived: false, version: 'v2', contentHash: autoContentHash,
    }
    const plan = planReconcile(
      { remoteId: 'PVT_board1', title: 'B', url: null, version: 'v2', statusFieldRemoteId: 'FIELD_STATUS', columns: [], items: [snapshotItem] },
      [link], [],
    )
    expect(plan.remoteUpdates).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.newItems).toHaveLength(0)
  })

  it('a re-fetch FAILURE leaves the op pending; the retry re-links without a second create', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new')
    const opId = (await enqueueItemCreate('bi-new', 'New card'))!

    // The create mints + persists the remote item, but the baseline re-fetch
    // fails transiently AFTER the create — before the link is written.
    stub.snapshotError = new Error('HTTP 500 from https://api.github.com/graphql')
    const first = await drainMutationQueue(getCred)

    // Retrying (not applied, not failed): the create succeeded and its remoteId
    // is persisted, so the op stays pending for a re-attempt.
    expect(first).toEqual({ applied: 0, conflicts: 0, failed: 0 })
    const held = queueRow(opId)
    expect(held.status).toBe('pending')
    expect(held.result).not.toBeNull() // minted remoteId persisted for idempotency
    expect(stub.applied.filter((a) => a.kind === 'create_item')).toHaveLength(1) // created exactly once
    expect(itemLinkRows('bi-new')).toHaveLength(0) // not linked yet (re-fetch threw before linking)

    // Retry with the re-fetch now succeeding: SKIPS applyMutation, re-fetches, links, applies.
    stub.snapshotError = null
    stub.applied = []
    const second = await drainMutationQueue(getCred)

    expect(second).toEqual({ applied: 1, conflicts: 0, failed: 0 })
    expect(queueRow(opId).status).toBe('applied')
    expect(stub.applied.filter((a) => a.kind === 'create_item')).toHaveLength(0) // NOT re-created
    expect(itemLinkRows('bi-new')).toHaveLength(1) // linked exactly once
  })
})

describe('outbox — pre-link edit capture (fixes data loss, no deferred op)', () => {
  it('an edit made WHILE the create was in flight is pushed as a NORMAL update after linking', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new') // backing task titled 'Test Task'

    // Create carries the title at enqueue time...
    await enqueueItemCreate('bi-new', 'Test Task')
    // ...then the user edits the card before the push completes.
    const taskId = getDb().select().from(boardItems).where(eq(boardItems.id, 'bi-new')).get()!.taskId
    getDb().update(tasks).set({ title: 'Edited in flight' }).where(eq(tasks.id, taskId)).run()

    await drainMutationQueue(getCred)

    const link = itemLinkRows('bi-new')[0]!
    // The divergence became a NORMAL pending update_item op on the live link —
    // NOT a deferred/self-re-pending op.
    const updates = getDb().select().from(mutationQueue)
      .where(and(eq(mutationQueue.remoteLinkId, link.id), eq(mutationQueue.kind, 'update_item')))
      .all()
    expect(updates).toHaveLength(1)
    expect(updates[0]!.status).toBe('pending')
    expect(updates[0]!.baseVersion).toBe('v2') // the create's new merge base
    expect(JSON.parse(updates[0]!.payload)).toMatchObject({
      kind: 'update_item',
      patch: { title: 'Edited in flight' },
    })
  })

  it('a create that fails fatally does NOT block later ops for the same credential', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new') // this create will fail fatally
    // A second, already-linked item on the SAME credential with a normal move.
    seedLink({
      localType: 'board_column', localId: 'col-done',
      remoteType: 'pv2_status_option', remoteId: 'OPT_DONE', containerRemoteId: 'PVT_board1',
    })
    seedLink({
      localType: 'board_item', localId: 'bi-linked',
      remoteType: 'pv2_item', remoteId: 'ITEM_linked',
      containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
    })

    // FIFO: the doomed create is enqueued FIRST, the move SECOND.
    const createOpId = (await enqueueItemCreate('bi-new', 'New card'))!
    const moveOpId = (await enqueueBoardItemMove('bi-linked', 'col-done'))!
    stub.failCreate = true

    const counts = await drainMutationQueue(getCred)

    // The create failed terminally, but the younger move STILL drained — the
    // credential's queue is NOT deadlocked (the deferred-op-chaining failure mode).
    expect(queueRow(createOpId).status).toBe('failed')
    expect(queueRow(moveOpId).status).toBe('applied')
    expect(counts).toEqual({ applied: 1, conflicts: 0, failed: 1 })
    expect(stub.applied.map((a) => a.kind)).toEqual(['move_item'])
    // The failed create left the card local-only — never linked, never re-created.
    expect(itemLinkRows('bi-new')).toHaveLength(0)
  })
})

describe('outbox — create idempotency (retry re-links, never re-creates)', () => {
  it('a create op with a persisted result re-links instead of calling applyMutation again', async () => {
    seedBoardLink()
    seedRealBoardItem('board-1', 'bi-new')
    const opId = (await enqueueItemCreate('bi-new', 'New card'))!

    // First drain: creates the remote item, links it, marks applied.
    await drainMutationQueue(getCred)
    expect(itemLinkRows('bi-new')).toHaveLength(1)
    expect(stub.applied.filter((a) => a.kind === 'create_item')).toHaveLength(1)

    // Simulate a crash that left the row re-pending AFTER the create succeeded
    // (result persisted). A retry must NOT call applyMutation again.
    getDb().update(mutationQueue).set({ status: 'pending' }).where(eq(mutationQueue.opId, opId)).run()
    stub.applied = []

    await drainMutationQueue(getCred)

    expect(queueRow(opId).status).toBe('applied')
    expect(stub.applied.filter((a) => a.kind === 'create_item')).toHaveLength(0) // NOT re-created
    expect(itemLinkRows('bi-new')).toHaveLength(1) // still exactly one link
  })
})

describe('outbox — recoverStaleInFlight', () => {
  it('resets in_flight ops to pending (crash recovery) and leaves other statuses alone', async () => {
    const linkId = seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', remoteVersion: 'v1',
    })
    const opIds: Record<string, string> = {}
    for (const status of ['in_flight', 'in_flight', 'pending', 'failed', 'applied', 'conflicted'] as const) {
      const opId = generateId()
      getDb().insert(mutationQueue).values({
        id: generateId(),
        opId,
        projectId,
        credentialId,
        source: 'github',
        remoteLinkId: linkId,
        kind: 'move_item',
        payload: '{}',
        baseVersion: 'v1',
        status,
        attempts: 1,
      }).run()
      opIds[opId] = status
    }

    expect(await recoverStaleInFlight()).toBe(2)

    for (const [opId, seededStatus] of Object.entries(opIds)) {
      const expected = seededStatus === 'in_flight' ? 'pending' : seededStatus
      expect(queueRow(opId).status).toBe(expected)
    }

    // Idempotent: nothing left to recover.
    expect(await recoverStaleInFlight()).toBe(0)
  })
})

describe('outbox — drainMutationQueue', () => {
  it('applies a pending move: status, result, link version, and applied event', async () => {
    const { itemLinkId } = seedMirroredMove('bi-1')
    const opId = (await enqueueBoardItemMove('bi-1', 'col-done'))!
    stub.remoteVersion = 'v1' // matches baseVersion — no drift

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 1, conflicts: 0, failed: 0 })
    const row = queueRow(opId)
    expect(row.status).toBe('applied')
    expect(row.attempts).toBe(1)
    expect(row.appliedAt).toBeTruthy()
    expect(JSON.parse(row.result!)).toMatchObject({ remoteVersion: 'v2' })

    // Successful push advances the link's merge base
    const link = getDb().select().from(remoteLinks).where(eq(remoteLinks.id, itemLinkId)).get()!
    expect(link.remoteVersion).toBe('v2')
    expect(link.lastPushedAt).toBeTruthy()

    const applied = eventsOfType('integration.mutation.applied')
    expect(applied).toHaveLength(1)
    expect(JSON.parse(applied[0]!.payload)).toMatchObject({ opId, overwroteRemote: false })
  })

  it('move_item is last-write-wins: pushes despite remote drift, logging overwroteRemote', async () => {
    seedMirroredMove('bi-1')
    const opId = (await enqueueBoardItemMove('bi-1', 'col-done'))!
    stub.remoteVersion = 'v9' // remote moved off base — LWW pushes anyway

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 1, conflicts: 0, failed: 0 })
    expect(queueRow(opId).status).toBe('applied')
    const applied = eventsOfType('integration.mutation.applied')
    expect(JSON.parse(applied[0]!.payload)).toMatchObject({ opId, overwroteRemote: true })
  })

  it('marks a drifted conflict-sensitive op as conflicted with a sync_conflicts row, without pushing', async () => {
    const linkId = seedLink({
      localType: 'task', localId: 't-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_t1', remoteVersion: 'v1',
    })
    const opId = await enqueueMutation(
      {
        credentialId, projectId, source: 'github', baseVersion: 'v1',
        op: { kind: 'update_item', ref: { remoteType: 'pv2_item', remoteId: 'ITEM_t1' }, patch: { title: 'New' } },
      },
      linkId,
    )
    stub.remoteVersion = 'v9' // drifted

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 0, conflicts: 1, failed: 0 })
    expect(queueRow(opId).status).toBe('conflicted')
    expect(stub.applied).toHaveLength(0) // never pushed

    const conflicts = getDb().select().from(syncConflicts).all()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.remoteLinkId).toBe(linkId)
    expect(JSON.parse(conflicts[0]!.remoteSnapshot)).toEqual({ version: 'v9' })
    expect(eventsOfType('integration.mutation.conflict')).toHaveLength(1)
  })

  it('retries transient errors, leaving the op pending, then fails after 5 attempts', async () => {
    seedMirroredMove('bi-1')
    const opId = (await enqueueBoardItemMove('bi-1', 'col-done'))!
    stub.applyError = new Error('HTTP 500 from https://api.github.com/graphql')

    for (let attempt = 1; attempt <= 4; attempt++) {
      const counts = await drainMutationQueue(getCred)
      expect(counts).toEqual({ applied: 0, conflicts: 0, failed: 0 })
      const row = queueRow(opId)
      expect(row.status).toBe('pending') // released for the next pass
      expect(row.attempts).toBe(attempt)
      expect(row.lastError).toContain('HTTP 500')
    }

    const counts = await drainMutationQueue(getCred) // 5th attempt — give up
    expect(counts).toEqual({ applied: 0, conflicts: 0, failed: 1 })
    const row = queueRow(opId)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(5)
    expect(eventsOfType('integration.mutation.failed')).toHaveLength(1)
  })

  it('fails immediately on UnsupportedMutationError — capability mismatch never retries', async () => {
    seedMirroredMove('bi-1')
    const opId = (await enqueueBoardItemMove('bi-1', 'col-done'))!
    stub.applyError = new UnsupportedMutationError('github', 'move_item')

    const counts = await drainMutationQueue(getCred)

    expect(counts).toEqual({ applied: 0, conflicts: 0, failed: 1 })
    const row = queueRow(opId)
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1) // single attempt — fatal, not transient
    expect(eventsOfType('integration.mutation.failed')).toHaveLength(1)
  })

  it('drains FIFO per credential and a concurrent drain skips the busy credential', async () => {
    seedBoardLink()
    seedLink({
      localType: 'board_column', localId: 'col-done',
      remoteType: 'pv2_status_option', remoteId: 'OPT_DONE', containerRemoteId: 'PVT_board1',
    })
    const opIds: string[] = []
    for (const localId of ['bi-1', 'bi-2', 'bi-3']) {
      seedLink({
        localType: 'board_item', localId,
        remoteType: 'pv2_item', remoteId: `ITEM_${localId}`,
        containerRemoteId: 'PVT_board1', remoteVersion: 'v1',
      })
      opIds.push((await enqueueBoardItemMove(localId, 'col-done'))!)
    }

    // First drain claims the credential synchronously; the overlapping call
    // must skip it entirely (single-flight per credential) instead of
    // interleaving pushes.
    const first = drainMutationQueue(getCred)
    const second = await drainMutationQueue(getCred)
    expect(second).toEqual({ applied: 0, conflicts: 0, failed: 0 })

    const counts = await first
    expect(counts).toEqual({ applied: 3, conflicts: 0, failed: 0 })
    // FIFO: applied in enqueue order
    expect(stub.applied.map((a) => a.opId)).toEqual(opIds)
  }, 10_000)
})
