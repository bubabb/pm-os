import { describe, it, expect } from 'vitest'
import type { RemoteLink, MutationQueueRow } from '@creare/database'
import type { MirrorBoardSnapshot, MirrorColumnSnapshot, MirrorItemSnapshot } from '../types'
import { planReconcile, columnSyncHash } from './reconciler'

// --- Fixtures ----------------------------------------------------------------
// Full typed rows (InferSelectModel shapes) with neutral defaults — tests only
// override the fields planReconcile actually reads.

const T = '2026-06-11T00:00:00.000Z'

function makeLink(overrides: Partial<RemoteLink> & Pick<RemoteLink, 'remoteId'>): RemoteLink {
  return {
    id: `link-${overrides.remoteId}`,
    projectId: 'proj-1',
    credentialId: 'cred-1',
    source: 'github',
    localType: 'board_item',
    localId: `local-${overrides.remoteId}`,
    remoteType: 'pv2_item',
    containerRemoteId: 'PVT_board1',
    remoteUrl: null,
    remoteVersion: T,
    lastSyncedHash: null,
    lastPulledAt: T,
    lastPushedAt: null,
    deletedAt: null,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }
}

function makeColumnLink(
  overrides: Partial<RemoteLink> & Pick<RemoteLink, 'remoteId'>,
): RemoteLink {
  return makeLink({ localType: 'board_column', remoteType: 'pv2_status_option', ...overrides })
}

function makeOp(overrides: Partial<MutationQueueRow>): MutationQueueRow {
  return {
    id: 'mq-1',
    opId: 'op-1',
    projectId: 'proj-1',
    credentialId: 'cred-1',
    source: 'github',
    remoteLinkId: null,
    kind: 'move',
    payload: '{}',
    baseVersion: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    appliedAt: null,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  }
}

function makeItem(
  overrides: Partial<MirrorItemSnapshot> & Pick<MirrorItemSnapshot, 'remoteId'>,
): MirrorItemSnapshot {
  return {
    containerRemoteId: 'PVT_board1',
    title: `Item ${overrides.remoteId}`,
    url: null,
    statusRemoteId: 'col-todo',
    state: 'open',
    archived: false,
    version: T,
    contentHash: `hash-${overrides.remoteId}`,
    ...overrides,
  }
}

function makeColumn(
  overrides: Partial<MirrorColumnSnapshot> & Pick<MirrorColumnSnapshot, 'remoteId'>,
): MirrorColumnSnapshot {
  return { name: 'Todo', position: 0, isTerminal: false, ...overrides }
}

function makeSnapshot(overrides: Partial<MirrorBoardSnapshot>): MirrorBoardSnapshot {
  return {
    remoteId: 'PVT_board1',
    title: 'Board One',
    url: null,
    version: T,
    statusFieldRemoteId: 'field-status',
    columns: [],
    items: [],
    ...overrides,
  }
}

const emptyPlan = {
  newItems: [],
  remoteUpdates: [],
  conflicts: [],
  remoteDeletes: [],
  columnChanges: { added: [], renamed: [] },
}

// --- Tests ---------------------------------------------------------------------

describe('planReconcile', () => {
  it('first import: no links → every item is new, every column is added', () => {
    const columns = [
      makeColumn({ remoteId: 'col-todo', name: 'Todo', position: 0 }),
      makeColumn({ remoteId: 'col-done', name: 'Done', position: 1, isTerminal: true }),
    ]
    const items = [makeItem({ remoteId: 'it-1' }), makeItem({ remoteId: 'it-2' })]
    const plan = planReconcile(makeSnapshot({ columns, items }), [], [])

    expect(plan).toEqual({
      ...emptyPlan,
      newItems: items,
      columnChanges: { added: columns, renamed: [] },
    })
  })

  it('unchanged item (contentHash === lastSyncedHash) produces no work', () => {
    const item = makeItem({ remoteId: 'it-1', contentHash: 'h-base' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })
    const plan = planReconcile(makeSnapshot({ items: [item] }), [link], [])

    expect(plan).toEqual(emptyPlan)
  })

  it('remote-only change → remoteUpdates (apply remote to local)', () => {
    const item = makeItem({ remoteId: 'it-1', contentHash: 'h-remote' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })
    const plan = planReconcile(makeSnapshot({ items: [item] }), [link], [])

    expect(plan.remoteUpdates).toEqual([{ link, item }])
    expect(plan.conflicts).toEqual([])
    expect(plan.newItems).toEqual([])
  })

  it('remote change + pending op on the same link → conflict, not update', () => {
    const item = makeItem({ remoteId: 'it-1', contentHash: 'h-remote' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })
    const op = makeOp({ remoteLinkId: link.id, opId: 'op-move-1', status: 'pending' })
    const plan = planReconcile(makeSnapshot({ items: [item] }), [link], [op])

    expect(plan.conflicts).toEqual([{ link, item, pendingOpId: 'op-move-1' }])
    expect(plan.remoteUpdates).toEqual([])
  })

  it('in_flight op also blocks the update; resolved statuses do not', () => {
    const item = makeItem({ remoteId: 'it-1', contentHash: 'h-remote' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })

    const inFlight = planReconcile(
      makeSnapshot({ items: [item] }),
      [link],
      [makeOp({ remoteLinkId: link.id, opId: 'op-2', status: 'in_flight' })],
    )
    expect(inFlight.conflicts.map((c) => c.pendingOpId)).toEqual(['op-2'])

    const applied = planReconcile(
      makeSnapshot({ items: [item] }),
      [link],
      [makeOp({ remoteLinkId: link.id, opId: 'op-3', status: 'applied' })],
    )
    expect(applied.conflicts).toEqual([])
    expect(applied.remoteUpdates).toEqual([{ link, item }])
  })

  it('pending op without a matching changed item causes no conflict', () => {
    const item = makeItem({ remoteId: 'it-1', contentHash: 'h-base' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })
    // Op targets an unrelated link; also one create-op with null remoteLinkId
    const ops = [
      makeOp({ id: 'mq-a', opId: 'op-a', remoteLinkId: 'link-other' }),
      makeOp({ id: 'mq-b', opId: 'op-b', remoteLinkId: null }),
    ]
    const plan = planReconcile(makeSnapshot({ items: [item] }), [link], ops)

    expect(plan).toEqual(emptyPlan)
  })

  it('linked item missing from snapshot → remoteDeletes', () => {
    const link = makeLink({ remoteId: 'it-gone', lastSyncedHash: 'h-base' })
    const plan = planReconcile(makeSnapshot({ items: [] }), [link], [])

    expect(plan.remoteDeletes).toEqual([link])
    expect(plan.newItems).toEqual([])
  })

  it('linked item archived remotely → remoteDeletes, never an update', () => {
    const item = makeItem({ remoteId: 'it-1', archived: true, contentHash: 'h-new' })
    const link = makeLink({ remoteId: 'it-1', lastSyncedHash: 'h-base' })
    const plan = planReconcile(makeSnapshot({ items: [item] }), [link], [])

    expect(plan.remoteDeletes).toEqual([link])
    expect(plan.remoteUpdates).toEqual([])
    expect(plan.newItems).toEqual([])
  })

  it('already-tombstoned links and unlinked archived items are ignored', () => {
    const tombstoned = makeLink({ remoteId: 'it-gone', deletedAt: T })
    const archivedNoLink = makeItem({ remoteId: 'it-arch', archived: true })
    const plan = planReconcile(makeSnapshot({ items: [archivedNoLink] }), [tombstoned], [])

    expect(plan).toEqual(emptyPlan)
  })

  it('new column with no link → columnChanges.added', () => {
    const known = makeColumn({ remoteId: 'col-todo', name: 'Todo', position: 0 })
    const fresh = makeColumn({ remoteId: 'col-review', name: 'Review', position: 1 })
    const knownLink = makeColumnLink({
      remoteId: 'col-todo',
      lastSyncedHash: columnSyncHash(known),
    })
    const plan = planReconcile(makeSnapshot({ columns: [known, fresh] }), [knownLink], [])

    expect(plan.columnChanges.added).toEqual([fresh])
    expect(plan.columnChanges.renamed).toEqual([])
  })

  it('column rename or reorder → columnChanges.renamed with new name/position', () => {
    const before = makeColumn({ remoteId: 'col-1', name: 'Todo', position: 0 })
    const link = makeColumnLink({ remoteId: 'col-1', lastSyncedHash: columnSyncHash(before) })

    const renamed = makeColumn({ remoteId: 'col-1', name: 'Backlog', position: 0 })
    const renamePlan = planReconcile(makeSnapshot({ columns: [renamed] }), [link], [])
    expect(renamePlan.columnChanges.renamed).toEqual([{ link, name: 'Backlog', position: 0 }])

    const moved = makeColumn({ remoteId: 'col-1', name: 'Todo', position: 2 })
    const movePlan = planReconcile(makeSnapshot({ columns: [moved] }), [link], [])
    expect(movePlan.columnChanges.renamed).toEqual([{ link, name: 'Todo', position: 2 }])

    const same = makeColumn({ remoteId: 'col-1', name: 'Todo', position: 0 })
    const noopPlan = planReconcile(makeSnapshot({ columns: [same] }), [link], [])
    expect(noopPlan.columnChanges.renamed).toEqual([])
  })

  it('column links never match items and vice versa (remoteType discrimination)', () => {
    // Same remoteId used by an item and a column — links must not cross-match
    const item = makeItem({ remoteId: 'shared-id' })
    const column = makeColumn({ remoteId: 'shared-id' })
    const columnLink = makeColumnLink({
      remoteId: 'shared-id',
      lastSyncedHash: columnSyncHash(column),
    })
    const plan = planReconcile(makeSnapshot({ items: [item], columns: [column] }), [columnLink], [])

    expect(plan.newItems).toEqual([item]) // item link absent → new, despite column link
    expect(plan.remoteDeletes).toEqual([]) // column link is not an item link
    expect(plan.columnChanges).toEqual({ added: [], renamed: [] })
  })

  it('is deterministic and side-effect-free', () => {
    const columns = [makeColumn({ remoteId: 'col-1' })]
    const items = [
      makeItem({ remoteId: 'it-new' }),
      makeItem({ remoteId: 'it-upd', contentHash: 'h-2' }),
    ]
    const snapshot = makeSnapshot({ columns, items })
    const links = [makeLink({ remoteId: 'it-upd', lastSyncedHash: 'h-1' })]
    const ops: MutationQueueRow[] = []

    const snapshotCopy = structuredClone(snapshot)
    const linksCopy = structuredClone(links)

    const a = planReconcile(snapshot, links, ops)
    const b = planReconcile(snapshot, links, ops)

    expect(a).toEqual(b)
    expect(snapshot).toEqual(snapshotCopy) // inputs untouched
    expect(links).toEqual(linksCopy)
  })
})
