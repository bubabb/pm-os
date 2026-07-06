import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@pm-os/database/testing'
import {
  getDb,
  integrationCredentials,
  mutationQueue,
  remoteLinks,
  syncConflicts,
} from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { and, eq } from 'drizzle-orm'
import { createMirror, pullMirror, getMirrorStatus } from './mirror-sync'
import type { IntegrationCredential, RemoteLink } from '@pm-os/database'
import type { MirrorBoardSnapshot, MirrorColumnSnapshot, MirrorItemSnapshot } from '../types'

// Stub the GitHub Projects client — pulls must never hit the network in tests.
// mirror-sync constructs the client itself, so the module is replaced
// wholesale (same pattern as outbox.test.ts / sync-engine.test.ts). The real
// boards.applyMirrorSnapshot runs against the in-memory test DB, so link and
// board state is exercised end-to-end.
const stub = vi.hoisted(() => ({
  snapshot: null as MirrorBoardSnapshot | null,
}))
vi.mock('../connectors/github-projects', () => ({
  GitHubProjectsClient: class {
    constructor(_token: string) {}
    async fetchProjectSnapshot(_remoteProjectId: string): Promise<MirrorBoardSnapshot> {
      if (stub.snapshot === null) throw new Error('test stub: no snapshot configured')
      return structuredClone(stub.snapshot)
    }
  },
  GitHubScopeError: class extends Error {},
  GitHubNotFoundError: class extends Error {},
}))

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId, 'github')
  stub.snapshot = null
})
afterEach(() => destroyTestDb())

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeColumn(
  overrides: Partial<MirrorColumnSnapshot> & Pick<MirrorColumnSnapshot, 'remoteId'>,
): MirrorColumnSnapshot {
  return { name: 'Todo', position: 0, isTerminal: false, ...overrides }
}

function makeItem(
  overrides: Partial<MirrorItemSnapshot> & Pick<MirrorItemSnapshot, 'remoteId'>,
): MirrorItemSnapshot {
  return {
    containerRemoteId: 'PVT_board1',
    title: `Item ${overrides.remoteId}`,
    url: null,
    statusRemoteId: 'OPT_TODO',
    state: 'open',
    archived: false,
    version: 'v1',
    contentHash: `hash-${overrides.remoteId}`,
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<MirrorBoardSnapshot>): MirrorBoardSnapshot {
  return {
    remoteId: 'PVT_board1',
    title: 'Board One',
    url: 'https://github.com/orgs/acme/projects/1',
    version: 'pv1',
    statusFieldRemoteId: 'FIELD_STATUS',
    columns: [makeColumn({ remoteId: 'OPT_TODO', name: 'Todo', position: 0 })],
    items: [],
    ...overrides,
  }
}

function getCredentialRow(): IntegrationCredential {
  return getDb()
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId))
    .get()!
}

function getItemLink(remoteId: string): RemoteLink {
  return getDb()
    .select()
    .from(remoteLinks)
    .where(and(eq(remoteLinks.remoteType, 'pv2_item'), eq(remoteLinks.remoteId, remoteId)))
    .get()!
}

// Import a one-column, one-item board and return its local boardId + item link.
async function importBoard(item: MirrorItemSnapshot): Promise<{ boardId: string; itemLink: RemoteLink }> {
  stub.snapshot = makeSnapshot({ items: [item] })
  const { boardId } = await createMirror(getCredentialRow(), 'tok', 'PVT_board1')
  return { boardId, itemLink: getItemLink(item.remoteId) }
}

function seedQueueRow(overrides: {
  remoteLinkId: string
  status: string
  lastError?: string
}): string {
  const opId = generateId()
  getDb().insert(mutationQueue).values({
    id: generateId(),
    opId,
    projectId,
    credentialId,
    source: 'github',
    remoteLinkId: overrides.remoteLinkId,
    kind: 'move_item',
    payload: '{}',
    baseVersion: 'v1',
    status: overrides.status,
    attempts: 1,
    lastError: overrides.lastError ?? null,
  }).run()
  return opId
}

function openConflictRows() {
  return getDb().select().from(syncConflicts).all().filter((c) => c.resolvedAt === null)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('mirror-sync — createMirror', () => {
  it('imports the snapshot as a new mirrored board with board/column/item links', async () => {
    const { boardId, itemLink } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    expect(boardId).toBeTruthy()
    expect(itemLink.lastSyncedHash).toBe('h1')
    expect(itemLink.containerRemoteId).toBe('PVT_board1')

    const boardLink = getDb()
      .select()
      .from(remoteLinks)
      .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, boardId)))
      .get()!
    expect(boardLink.remoteId).toBe('PVT_board1')
    expect(boardLink.containerRemoteId).toBe('FIELD_STATUS') // outbox.ts convention
  })
})

describe('mirror-sync — pullMirror conflict persistence', () => {
  it('persists a sync_conflicts row per conflicted link (mutationId null, snapshots recorded)', async () => {
    const { boardId, itemLink } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    // Local divergence: a FAILED push op on the item link (the silent-revert
    // finding — failed must count, not just pending/in_flight) …
    const failedOpId = seedQueueRow({ remoteLinkId: itemLink.id, status: 'failed', lastError: 'boom' })
    // … and the remote moved off base too.
    stub.snapshot = makeSnapshot({
      items: [makeItem({ remoteId: 'IT_1', title: 'Renamed remotely', contentHash: 'h2' })],
    })

    const result = await pullMirror(getCredentialRow(), 'tok', boardId)
    expect(result.conflicts).toBe(1)
    expect(result.pulled).toBe(0) // the conflicted item is never applied locally

    const rows = openConflictRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.remoteLinkId).toBe(itemLink.id)
    expect(rows[0]!.mutationId).toBeNull() // pull-side conflict
    expect(JSON.parse(rows[0]!.remoteSnapshot)).toMatchObject({ remoteId: 'IT_1', contentHash: 'h2' })
    expect(JSON.parse(rows[0]!.baseSnapshot)).toMatchObject({ lastSyncedHash: 'h1' })
    expect(JSON.parse(rows[0]!.localSnapshot)).toMatchObject({ pendingOpId: failedOpId })

    // The conflicted link's merge base is untouched — local state preserved.
    expect(getItemLink('IT_1').lastSyncedHash).toBe('h1')

    // Repeated pull of the same divergence: still ONE open row (idempotent).
    const again = await pullMirror(getCredentialRow(), 'tok', boardId)
    expect(again.conflicts).toBe(1)
    expect(openConflictRows()).toHaveLength(1)
  })

  it('applies a clean remote update (no unresolved op) without recording a conflict', async () => {
    const { boardId } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    stub.snapshot = makeSnapshot({
      items: [makeItem({ remoteId: 'IT_1', title: 'Renamed remotely', contentHash: 'h2' })],
    })

    const result = await pullMirror(getCredentialRow(), 'tok', boardId)
    expect(result).toEqual({ pulled: 1, conflicts: 0 })
    expect(openConflictRows()).toHaveLength(0)
    expect(getItemLink('IT_1').lastSyncedHash).toBe('h2') // remote applied → new base
  })
})

describe('mirror-sync — getMirrorStatus', () => {
  it('reports an unlinked board with zeroed counters', async () => {
    expect(await getMirrorStatus('not-a-mirrored-board')).toEqual({
      linked: false,
      source: null,
      remoteUrl: null,
      lastPulledAt: null,
      pendingPushes: 0,
      openConflicts: 0,
      failedPushes: 0,
    })
  })

  it('counts pendingPushes, failedPushes, and openConflicts separately', async () => {
    const { boardId, itemLink } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    seedQueueRow({ remoteLinkId: itemLink.id, status: 'pending' })
    seedQueueRow({ remoteLinkId: itemLink.id, status: 'in_flight' })
    seedQueueRow({ remoteLinkId: itemLink.id, status: 'failed', lastError: 'no remote link' })
    seedQueueRow({ remoteLinkId: itemLink.id, status: 'applied' }) // resolved — counted nowhere
    getDb().insert(syncConflicts).values({
      id: generateId(),
      projectId,
      remoteLinkId: itemLink.id,
      mutationId: null,
      baseSnapshot: '{}',
      localSnapshot: '{}',
      remoteSnapshot: '{}',
    }).run()

    const status = await getMirrorStatus(boardId)
    expect(status.linked).toBe(true)
    expect(status.source).toBe('github')
    expect(status.pendingPushes).toBe(2) // pending + in_flight only
    expect(status.failedPushes).toBe(1) // failed rows surface on the chip
    expect(status.openConflicts).toBe(1)
  })

  it('counts pending create_item ops (remoteLinkId null) for this board in pendingPushes', async () => {
    const { boardId, itemLink } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    seedQueueRow({ remoteLinkId: itemLink.id, status: 'pending' }) // attributed via its link
    // A freshly-created card: no remote link yet — the op JSON carries the
    // board's container ref instead (outbox.enqueueItemCreate shape).
    const insertCreateOp = (containerRemoteId: string, status: string): void => {
      getDb().insert(mutationQueue).values({
        id: generateId(),
        opId: generateId(),
        projectId,
        credentialId,
        source: 'github',
        remoteLinkId: null,
        kind: 'create_item',
        payload: JSON.stringify({
          kind: 'create_item',
          container: { remoteType: 'pv2_project', remoteId: containerRemoteId },
          title: 'New card',
          localBoardItemId: generateId(),
        }),
        baseVersion: null,
        status,
        attempts: 0,
      }).run()
    }
    insertCreateOp('PVT_board1', 'pending')      // this board → counted
    insertCreateOp('PVT_board1', 'in_flight')    // this board → counted
    insertCreateOp('PVT_board1', 'applied')      // resolved → not counted
    insertCreateOp('PVT_other', 'pending')       // another board → not counted

    const status = await getMirrorStatus(boardId)
    expect(status.pendingPushes).toBe(3) // 1 linked move + 2 active creates
  })

  it('treats a tombstoned board link as not mirrored (status unlinked, pull refused)', async () => {
    const { boardId } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    // deleteBoard tombstones the board link — a pull must not resurrect it.
    getDb().update(remoteLinks)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(remoteLinks.localType, 'board'), eq(remoteLinks.localId, boardId)))
      .run()

    const status = await getMirrorStatus(boardId)
    expect(status.linked).toBe(false)
    expect(status.pendingPushes).toBe(0)

    await expect(pullMirror(getCredentialRow(), 'tok', boardId))
      .rejects.toThrow(/no live remote link/)
  })

  it('openConflicts reflects conflicts persisted by pullMirror', async () => {
    const { boardId, itemLink } = await importBoard(makeItem({ remoteId: 'IT_1', contentHash: 'h1' }))

    seedQueueRow({ remoteLinkId: itemLink.id, status: 'failed', lastError: 'boom' })
    stub.snapshot = makeSnapshot({
      items: [makeItem({ remoteId: 'IT_1', title: 'Renamed remotely', contentHash: 'h2' })],
    })
    await pullMirror(getCredentialRow(), 'tok', boardId)

    const status = await getMirrorStatus(boardId)
    expect(status.openConflicts).toBe(1)
    expect(status.failedPushes).toBe(1)
  })
})
