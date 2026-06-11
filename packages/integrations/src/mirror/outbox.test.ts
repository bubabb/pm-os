import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import {
  getDb,
  events,
  integrationCredentials,
  mutationQueue,
  remoteLinks,
  syncConflicts,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { and, eq } from 'drizzle-orm'
import { UnsupportedMutationError } from '../connectors/base'
import { enqueueMutation, enqueueBoardItemMove, drainMutationQueue } from './outbox'
import type { IntegrationCredential } from '@creare/database'
import type { MutationEnvelope, MutationOp } from '../types'

// Stub the GitHub connector — the drain must never hit the network in tests.
// outbox.ts builds connectors itself (buildConnector pattern), so the module
// is replaced wholesale, mirroring sync-engine.test.ts.
const stub = vi.hoisted(() => ({
  applyError: null as Error | null,
  remoteVersion: null as string | null,
  applied: [] as Array<{ opId: string; kind: string }>,
}))
vi.mock('../connectors/github', () => ({
  GitHubConnector: class {
    constructor(_config: unknown) {}
    async applyMutation(envelope: MutationEnvelope) {
      if (stub.applyError) throw stub.applyError
      stub.applied.push({ opId: envelope.opId, kind: envelope.op.kind })
      return { ref: { remoteType: 'pv2_item', remoteId: 'ITEM_1' }, remoteVersion: 'v2', raw: {} }
    }
    async fetchRemoteVersion(_ref: unknown) {
      return stub.remoteVersion
    }
  },
}))

let projectId: string
let credentialId: string

beforeEach(() => {
  ;({ projectId } = seedWorkspace())
  credentialId = seedCredential(projectId, 'github')
  stub.applyError = null
  stub.remoteVersion = null
  stub.applied = []
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

  it('throws when the item is mirrored but the target column has no link', async () => {
    seedLink({
      localType: 'board_item', localId: 'bi-1',
      remoteType: 'pv2_item', remoteId: 'ITEM_bi-1', containerRemoteId: 'PVT_board1',
    })
    await expect(enqueueBoardItemMove('bi-1', 'col-unlinked')).rejects.toThrow(/no remote link/)
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
