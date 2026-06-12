import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OneDriveConnector, OneDriveConflictError } from './onedrive'
import { UnsupportedMutationError } from './base'
import type { MutationEnvelope, MutationOp } from '../types'

// All tests mock global fetch — no real network, ever.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function connector(metadata?: Record<string, unknown>): OneDriveConnector {
  return new OneDriveConnector({
    credentialId: 'cred-1',
    projectId: 'proj-1',
    token: 'graph-token',
    ...(metadata !== undefined ? { metadata } : {}),
  })
}

function envelope(op: MutationOp, baseVersion: string | null = null): MutationEnvelope {
  return {
    opId: 'op-1',
    credentialId: 'cred-1',
    projectId: 'proj-1',
    source: 'onedrive',
    baseVersion,
    op,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// listResources fans out to /root/children and /sharedWithMe concurrently, so
// per-call mockResolvedValueOnce ordering is fragile — dispatch on URL instead.
function mockGraphByUrl(routes: Array<[match: string, body: unknown]>): void {
  fetchMock.mockImplementation((url: string) => {
    const hit = routes.find(([match]) => url.includes(match))
    if (!hit) return Promise.resolve(jsonResponse({ error: { code: 'itemNotFound' } }, 404))
    return Promise.resolve(jsonResponse(hit[1]))
  })
}

function requestAt(callIndex: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[callIndex] as [string, RequestInit]
  return { url: call[0], init: call[1] }
}

function bodyAt(callIndex: number): Record<string, unknown> {
  return JSON.parse(requestAt(callIndex).init.body as string) as Record<string, unknown>
}

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((call) => (call as [string, RequestInit])[0])
}

const fileRef = { remoteType: 'file', remoteId: 'item-abc' }

describe('OneDriveConnector — listResources', () => {
  it('merges own-drive root folders with sharedWithMe folders, addressed by {driveId, itemId}', async () => {
    mockGraphByUrl([
      ['/me/drive/sharedWithMe', {
        value: [
          {
            id: 'stub-1',
            name: 'Team Specs',
            remoteItem: {
              id: 'remote-folder-1',
              folder: { childCount: 12 },
              parentReference: { driveId: 'drive-bob' },
              shared: { sharedBy: { user: { displayName: 'Bob Vance' } } },
            },
          },
          // Shared FILE (no folder facet on stub or remoteItem) — not pickable
          {
            id: 'stub-2',
            name: 'budget.xlsx',
            remoteItem: { id: 'remote-file-2', parentReference: { driveId: 'drive-bob' } },
          },
          // Malformed stub without a remoteItem facet — skipped, never crashes
          { id: 'stub-3', name: 'ghost' },
        ],
      }],
      ['/me/drive/root/children', {
        value: [
          { id: 'own-folder-1', name: 'Documents', folder: { childCount: 3 } },
          { id: 'own-file-1', name: 'notes.txt' }, // files filtered out
        ],
      }],
    ])

    const options = await connector().listResources()

    expect(options).toEqual([
      {
        id: 'own-folder-1',
        label: 'Documents',
        metadata: { driveId: 'me', itemId: 'own-folder-1', folder: 'Documents' },
      },
      {
        id: 'remote-folder-1',
        label: 'Team Specs (shared by Bob Vance)',
        metadata: { driveId: 'drive-bob', itemId: 'remote-folder-1', folder: 'Team Specs' },
      },
    ])

    // Both Graph surfaces were queried with Bearer auth
    const urls = calledUrls()
    expect(urls.some((u) => u.includes('/me/drive/root/children'))).toBe(true)
    expect(urls.some((u) => u.includes('/me/drive/sharedWithMe'))).toBe(true)
    const headers = requestAt(0).init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer graph-token')
  })

  it('labels a shared folder without sharer info as "(shared)"', async () => {
    mockGraphByUrl([
      ['/me/drive/sharedWithMe', {
        value: [{
          id: 'stub-1',
          name: 'Anon Drop',
          remoteItem: {
            id: 'remote-9',
            folder: { childCount: 0 },
            parentReference: { driveId: 'drive-x' },
          },
        }],
      }],
      ['/me/drive/root/children', { value: [] }],
    ])

    const options = await connector().listResources()
    expect(options).toEqual([{
      id: 'remote-9',
      label: 'Anon Drop (shared)',
      metadata: { driveId: 'drive-x', itemId: 'remote-9', folder: 'Anon Drop' },
    }])
  })

  it('dedupes by itemId when the same folder appears in both surfaces', async () => {
    mockGraphByUrl([
      ['/me/drive/sharedWithMe', {
        value: [{
          id: 'stub-1',
          name: 'Documents',
          remoteItem: {
            id: 'own-folder-1', // same item already listed from the own root
            folder: { childCount: 3 },
            parentReference: { driveId: 'drive-self' },
          },
        }],
      }],
      ['/me/drive/root/children', {
        value: [{ id: 'own-folder-1', name: 'Documents', folder: { childCount: 3 } }],
      }],
    ])

    const options = await connector().listResources()
    expect(options).toHaveLength(1)
    expect(options[0]?.metadata).toEqual({ driveId: 'me', itemId: 'own-folder-1', folder: 'Documents' })
  })

  it('follows @odata.nextLink on the own-drive root listing', async () => {
    mockGraphByUrl([
      ['/me/drive/sharedWithMe', { value: [] }],
      ['root/children?page=2', {
        value: [{ id: 'f-2', name: 'Beta', folder: { childCount: 0 } }],
      }],
      ['/me/drive/root/children', {
        value: [{ id: 'f-1', name: 'Alpha', folder: { childCount: 0 } }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?page=2',
      }],
    ])

    const options = await connector().listResources()
    expect(options.map((o) => o.id)).toEqual(['f-1', 'f-2'])
    expect(calledUrls()).toContain('https://graph.microsoft.com/v1.0/me/drive/root/children?page=2')
  })
})

describe('OneDriveConnector — fetchEntities (folder scope)', () => {
  const drivePage = {
    value: [{
      id: 'item-1',
      name: 'spec.md',
      webUrl: 'https://contoso-my.sharepoint.com/spec.md',
      lastModifiedDateTime: '2026-06-10T12:00:00Z',
      lastModifiedBy: { user: { displayName: 'Ada' } },
    }],
  }

  it('falls back to /me/drive/recent when no metadata is bound', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(drivePage))

    const result = await connector().fetchEntities()

    expect(requestAt(0).url).toContain('https://graph.microsoft.com/v1.0/me/drive/recent?')
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]).toMatchObject({
      source: 'onedrive',
      entityType: 'file',
      entityId: 'item-1',
      title: 'spec.md',
      assignee: 'Ada',
    })
    expect(result.nextCursor).toBeNull()
  })

  it('tolerates a legacy {folder}-only binding by falling back to recent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(drivePage))

    await connector({ folder: 'Documents' }).fetchEntities()

    expect(requestAt(0).url).toContain('/me/drive/recent?')
  })

  it('fetches the bound folder children via /me/drive for the own-drive sentinel', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(drivePage))

    await connector({ driveId: 'me', itemId: 'own-folder-1' }).fetchEntities()

    expect(requestAt(0).url).toContain(
      'https://graph.microsoft.com/v1.0/me/drive/items/own-folder-1/children?',
    )
  })

  it('fetches a shared folder via /drives/{driveId}/items/{itemId}/children', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(drivePage))

    await connector({ driveId: 'drive-bob', itemId: 'remote-folder-1' }).fetchEntities()

    expect(requestAt(0).url).toContain(
      'https://graph.microsoft.com/v1.0/drives/drive-bob/items/remote-folder-1/children?',
    )
  })

  it('surfaces @odata.nextLink as the cursor and resumes from it verbatim', async () => {
    const nextLink = 'https://graph.microsoft.com/v1.0/drives/drive-bob/items/remote-folder-1/children?$skiptoken=abc'
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...drivePage, '@odata.nextLink': nextLink }))

    const conn = connector({ driveId: 'drive-bob', itemId: 'remote-folder-1' })
    const page1 = await conn.fetchEntities()
    expect(page1.nextCursor).toBe(nextLink)

    fetchMock.mockResolvedValueOnce(jsonResponse(drivePage))
    const page2 = await conn.fetchEntities(page1.nextCursor ?? undefined)
    expect(requestAt(1).url).toBe(nextLink)
    expect(page2.nextCursor).toBeNull()
  })
})

describe('OneDriveConnector — capabilities', () => {
  it('declares rename + move only (no board mirror)', () => {
    expect(connector().capabilities).toEqual({ write: ['update_item', 'move_item'] })
  })
})

describe('OneDriveConnector — update_item (rename)', () => {
  it('PATCHes the drive item name and returns the response eTag as remoteVersion', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      id: 'item-abc',
      name: 'Q3 report.docx',
      eTag: '"etag-after"',
      webUrl: 'https://contoso-my.sharepoint.com/doc.docx',
    }))

    const result = await connector().applyMutation(envelope(
      { kind: 'update_item', ref: fileRef, patch: { title: 'Q3 report.docx' } },
      '"etag-before"',
    ))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const patch = requestAt(0)
    expect(patch.url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/item-abc')
    expect(patch.init.method).toBe('PATCH')
    expect(bodyAt(0)).toEqual({ name: 'Q3 report.docx' })

    // Optimistic concurrency: the eTag we last saw rides along as If-Match
    const headers = patch.init.headers as Record<string, string>
    expect(headers['If-Match']).toBe('"etag-before"')
    expect(headers['Authorization']).toBe('Bearer graph-token')

    expect(result.remoteVersion).toBe('"etag-after"')
    expect(result.remoteUrl).toBe('https://contoso-my.sharepoint.com/doc.docx')
    expect(result.ref).toEqual(fileRef)
  })

  it('addresses a shared-drive item via /drives/{driveId} when ref.containerId is set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'item-abc', name: 'renamed.md', eTag: '"e2"' }))

    const sharedRef = { remoteType: 'file', remoteId: 'item-abc', containerId: 'drive-bob' }
    await connector().applyMutation(envelope(
      { kind: 'update_item', ref: sharedRef, patch: { title: 'renamed.md' } },
    ))

    expect(requestAt(0).url).toBe('https://graph.microsoft.com/v1.0/drives/drive-bob/items/item-abc')
  })

  it('keeps the /me/drive form when containerId is the own-drive sentinel', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'item-abc', name: 'renamed.md', eTag: '"e2"' }))

    const ownRef = { remoteType: 'file', remoteId: 'item-abc', containerId: 'me' }
    await connector().applyMutation(envelope(
      { kind: 'update_item', ref: ownRef, patch: { title: 'renamed.md' } },
    ))

    expect(requestAt(0).url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/item-abc')
  })

  it('omits If-Match when no base eTag is known', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'item-abc', name: 'renamed.md', eTag: '"e2"' }))

    await connector().applyMutation(envelope(
      { kind: 'update_item', ref: fileRef, patch: { title: 'renamed.md' } },
    ))

    const headers = requestAt(0).init.headers as Record<string, string>
    expect(headers['If-Match']).toBeUndefined()
  })

  it('rejects update_item without a title — files only support renames', async () => {
    await expect(connector().applyMutation(envelope(
      { kind: 'update_item', ref: fileRef, patch: { body: 'new contents' } },
    ))).rejects.toThrow('patch.title is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('OneDriveConnector — move_item', () => {
  it('PATCHes parentReference.id with the target folder id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'item-abc', name: 'doc.md', eTag: '"e3"' }))

    const result = await connector().applyMutation(envelope({
      kind: 'move_item',
      ref: fileRef,
      toStatusRemoteId: 'folder-xyz',
    }))

    const patch = requestAt(0)
    expect(patch.url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/item-abc')
    expect(patch.init.method).toBe('PATCH')
    expect(bodyAt(0)).toEqual({ parentReference: { id: 'folder-xyz' } })

    expect(result.remoteVersion).toBe('"e3"')
  })

  it('classifies a failed precondition (412 stale eTag) as a retryable OneDriveConflictError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'resourceModified' } }, 412))

    const push = connector().applyMutation(envelope(
      { kind: 'move_item', ref: fileRef, toStatusRemoteId: 'folder-xyz' },
      '"stale-etag"',
    ))
    await expect(push).rejects.toBeInstanceOf(OneDriveConflictError)
    await expect(push).rejects.toMatchObject({ retryable: true })
  })

  it('still throws a generic error for non-412 failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'nameAlreadyExists' } }, 409))

    await expect(connector().applyMutation(envelope(
      { kind: 'move_item', ref: fileRef, toStatusRemoteId: 'folder-xyz' },
    ))).rejects.toThrow('HTTP 409')
  })
})

describe('OneDriveConnector — unsupported mutations', () => {
  it('throws UnsupportedMutationError for kinds outside its capability set', async () => {
    await expect(connector().applyMutation(envelope({
      kind: 'comment',
      ref: fileRef,
      body: 'nope',
    }))).rejects.toBeInstanceOf(UnsupportedMutationError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
