import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, seedCredential, destroyTestDb } from '@creare/database/testing'
import {
  getDb,
  integrationCredentials,
  mutationQueue,
  remoteLinks,
  syncConflicts,
  tasks,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { getBoardItem, getColumn } from '@creare/boards'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createMirror, pullMirror } from './mirror-sync'
import { listOpenConflicts, resolveConflict } from './conflicts'
import type { IntegrationCredential, RemoteLink } from '@creare/database'
import type { MirrorBoardSnapshot, MirrorItemSnapshot } from '../types'

// Stub the GitHub Projects client — same wholesale module replacement as
// mirror-sync.test.ts; the snapshot reaches mirror-sync through the connector's
// fetchBoardSnapshot, which delegates to this stubbed client.
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

// Two-column board so remote_wins has somewhere to move the item to.
function makeSnapshot(items: MirrorItemSnapshot[]): MirrorBoardSnapshot {
  return {
    remoteId: 'PVT_board1',
    title: 'Board One',
    url: 'https://github.com/orgs/acme/projects/1',
    version: 'pv1',
    statusFieldRemoteId: 'FIELD_STATUS',
    columns: [
      { remoteId: 'OPT_TODO', name: 'Todo', position: 0, isTerminal: false },
      { remoteId: 'OPT_DONE', name: 'Done', position: 1, isTerminal: true },
    ],
    items,
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

function seedQueueRow(remoteLinkId: string, status: string): string {
  const opId = generateId()
  getDb().insert(mutationQueue).values({
    id: generateId(),
    opId,
    projectId,
    credentialId,
    source: 'github',
    remoteLinkId,
    kind: 'move_item',
    payload: '{}',
    baseVersion: 'v1',
    status,
    attempts: 1,
  }).run()
  return opId
}

function opStatus(opId: string): string {
  return getDb().select().from(mutationQueue).where(eq(mutationQueue.opId, opId)).get()!.status
}

// Never called in Phase 1 resolutions — present to match the route's wiring.
const getCredential = async (): Promise<{ credential: IntegrationCredential; token: string }> => {
  throw new Error('test: getCredential must not be called by Phase 1 resolutions')
}

// Import the board, diverge BOTH sides (failed local push + remote rename/move
// to Done), pull to persist the conflict, and return the conflict's context.
async function setupConflict(): Promise<{
  boardId: string
  itemLink: RemoteLink
  failedOpId: string
  conflictId: string
}> {
  stub.snapshot = makeSnapshot([makeItem({ remoteId: 'IT_1', contentHash: 'h1' })])
  const { boardId } = await createMirror(getCredentialRow(), 'tok', 'PVT_board1')
  const itemLink = getItemLink('IT_1')

  const failedOpId = seedQueueRow(itemLink.id, 'failed')
  stub.snapshot = makeSnapshot([
    makeItem({ remoteId: 'IT_1', title: 'Renamed remotely', statusRemoteId: 'OPT_DONE', contentHash: 'h2' }),
  ])
  const { conflicts } = await pullMirror(getCredentialRow(), 'tok', boardId)
  expect(conflicts).toBe(1)

  const row = getDb().select().from(syncConflicts).all().find((c) => c.resolvedAt === null)!
  return { boardId, itemLink, failedOpId, conflictId: row.id }
}

function columnName(columnId: string): string {
  return getColumn(columnId)!.name
}

// ── listOpenConflicts ────────────────────────────────────────────────────────

describe('conflicts — listOpenConflicts', () => {
  it('renders the conflict in human terms (titles, both columns, boardId)', async () => {
    const { boardId, itemLink, conflictId } = await setupConflict()

    const views = await listOpenConflicts(projectId)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      id: conflictId,
      remoteLinkId: itemLink.id,
      boardId,
      itemTitle: 'Renamed remotely',
    })
    expect(views[0]!.localSummary).toContain('"Todo"')
    expect(views[0]!.remoteSummary).toContain('"Done"')
    expect(views[0]!.createdAt).toBeTruthy()
  })

  it('filters by boardId and returns [] for an unmirrored board', async () => {
    const { boardId } = await setupConflict()

    expect(await listOpenConflicts(projectId, boardId)).toHaveLength(1)
    expect(await listOpenConflicts(projectId, 'not-a-board')).toHaveLength(0)
  })
})

// ── resolveConflict ──────────────────────────────────────────────────────────

describe('conflicts — resolveConflict', () => {
  it('dismiss: marks resolved, cancels the parked failed op, changes no data', async () => {
    const { itemLink, failedOpId, conflictId } = await setupConflict()
    const before = getBoardItem(itemLink.localId)!

    await resolveConflict(conflictId, 'dismiss', getCredential)

    const row = getDb().select().from(syncConflicts).where(eq(syncConflicts.id, conflictId)).get()!
    expect(row.resolution).toBe('dismissed')
    expect(row.resolvedAt).not.toBeNull()
    expect(opStatus(failedOpId)).toBe('cancelled')
    // Neither side changed: item still in Todo, merge base untouched.
    expect(getBoardItem(itemLink.localId)!.columnId).toBe(before.columnId)
    expect(getItemLink('IT_1').lastSyncedHash).toBe('h1')
    expect(await listOpenConflicts(projectId)).toHaveLength(0)
  })

  it('remote_wins: applies the remote snapshot locally and cancels local ops', async () => {
    const { boardId, itemLink, failedOpId, conflictId } = await setupConflict()
    const pendingOpId = seedQueueRow(itemLink.id, 'pending')

    await resolveConflict(conflictId, 'remote_wins', getCredential)

    // Item moved to the remote's column, task renamed, merge base = remote hash.
    const item = getBoardItem(itemLink.localId)!
    expect(columnName(item.columnId)).toBe('Done')
    const task = getDb().select().from(tasks).where(eq(tasks.id, item.taskId)).get()!
    expect(task.title).toBe('Renamed remotely')
    expect(getItemLink('IT_1').lastSyncedHash).toBe('h2')

    // The discarded local intent can never be pushed.
    expect(opStatus(failedOpId)).toBe('cancelled')
    expect(opStatus(pendingOpId)).toBe('cancelled')

    const row = getDb().select().from(syncConflicts).where(eq(syncConflicts.id, conflictId)).get()!
    expect(row.resolution).toBe('remote_wins')
    expect(row.resolvedAt).not.toBeNull()

    // The divergence is gone: the next pull of the same snapshot is clean.
    const again = await pullMirror(getCredentialRow(), 'tok', boardId)
    expect(again).toEqual({ pulled: 0, conflicts: 0 })
  })

  it('local_wins: re-pushes the local column AND title (forced), cancels the old op', async () => {
    const { itemLink, failedOpId, conflictId } = await setupConflict()

    await resolveConflict(conflictId, 'local_wins', getCredential)

    expect(opStatus(failedOpId)).toBe('cancelled')

    // Fresh pending ops re-asserting BOTH the local column (Todo → OPT_TODO)
    // and the local title (which differs from the remote rename) — the latter
    // forced so the drift probe overwrites the drifted remote instead of
    // re-conflicting. This is the silent-loss fix: local content actually wins.
    const fresh = getDb().select().from(mutationQueue)
      .where(and(eq(mutationQueue.remoteLinkId, itemLink.id), eq(mutationQueue.status, 'pending')))
      .all()
    expect(fresh).toHaveLength(2)
    const byKind = new Map(fresh.map((r) => [r.kind, JSON.parse(r.payload) as Record<string, unknown>]))

    expect(byKind.get('move_item')).toMatchObject({
      kind: 'move_item',
      toStatusRemoteId: 'OPT_TODO',
      statusFieldRemoteId: 'FIELD_STATUS',
    })
    // Local title 'Item IT_1' overwrites the remote 'Renamed remotely'.
    expect(byKind.get('update_item')).toMatchObject({
      kind: 'update_item',
      patch: { title: 'Item IT_1' },
      force: true,
    })

    const row = getDb().select().from(syncConflicts).where(eq(syncConflicts.id, conflictId)).get()!
    expect(row.resolution).toBe('local_wins')
    expect(row.resolvedAt).not.toBeNull()
  })

  it('local_wins: skips an unsupported reopen (capability-gated) with a warn instead of a failing op', async () => {
    // Local reopened (task pending = open) while remote closed. Jira/Confluence
    // lack reopen_item, so the reopen must be SKIPPED, not enqueued to fail.
    const { itemLink, conflictId } = await setupConflict()
    // Force the link's source to a connector without reopen_item.
    getDb().update(remoteLinks).set({ source: 'jira' }).where(eq(remoteLinks.id, itemLink.id)).run()
    // Make the stored remote snapshot 'closed' so local(open) vs remote(closed)
    // triggers the reopen branch.
    const conflict = getDb().select().from(syncConflicts).where(eq(syncConflicts.id, conflictId)).get()!
    const remoteSnap = JSON.parse(conflict.remoteSnapshot) as Record<string, unknown>
    remoteSnap['state'] = 'closed'
    getDb().update(syncConflicts).set({ remoteSnapshot: JSON.stringify(remoteSnap) })
      .where(eq(syncConflicts.id, conflictId)).run()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await resolveConflict(conflictId, 'local_wins', getCredential)
    warn.mockRestore()

    // No reopen_item op was enqueued (Jira can't perform it).
    const ops = getDb().select().from(mutationQueue)
      .where(and(eq(mutationQueue.remoteLinkId, itemLink.id), eq(mutationQueue.status, 'pending')))
      .all()
    expect(ops.some((r) => r.kind === 'reopen_item')).toBe(false)
  })

  it('local_wins: re-pushes a local CLOSE for a push-side conflict (remote state unknown)', async () => {
    // A push-side conflict's stored snapshot is { version } only, so the remote
    // open/closed state is unknown (parseRemoteItemSnapshot → null). Previously the
    // close/reopen re-push was guarded on remote !== null, so a locally-closed card
    // was silently dropped here and reverted to open on the next pull. It must now
    // re-assert the local close directly.
    const { itemLink, conflictId } = await setupConflict()
    const item = getBoardItem(itemLink.localId)!
    getDb().update(tasks).set({ status: 'completed' }).where(eq(tasks.id, item.taskId)).run()
    getDb().update(syncConflicts).set({ remoteSnapshot: JSON.stringify({ version: 'v9' }) })
      .where(eq(syncConflicts.id, conflictId)).run()

    await resolveConflict(conflictId, 'local_wins', getCredential)

    const ops = getDb().select().from(mutationQueue)
      .where(and(eq(mutationQueue.remoteLinkId, itemLink.id), eq(mutationQueue.status, 'pending')))
      .all()
    const close = ops.find((r) => r.kind === 'close_item')
    expect(close).toBeDefined()
    expect((JSON.parse(close!.payload) as { force?: boolean }).force).toBe(true)
  })

  it('throws clear errors for unknown and already-resolved conflicts', async () => {
    const { conflictId } = await setupConflict()

    await expect(resolveConflict('nope', 'dismiss', getCredential))
      .rejects.toThrow('no sync conflict with id nope')

    await resolveConflict(conflictId, 'dismiss', getCredential)
    await expect(resolveConflict(conflictId, 'dismiss', getCredential))
      .rejects.toThrow('already resolved')
  })
})
