import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ConfluenceConnector } from './confluence'
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

const BASE_URL = 'https://example.atlassian.net'

function connector(): ConfluenceConnector {
  return new ConfluenceConnector({
    credentialId: 'cred-1',
    projectId: 'proj-1',
    token: 'api-token',
    baseUrl: BASE_URL,
    metadata: { email: 'pm@example.com' },
  })
}

function envelope(op: MutationOp, baseVersion: string | null = null): MutationEnvelope {
  return {
    opId: 'op-1',
    credentialId: 'cred-1',
    projectId: 'proj-1',
    source: 'confluence',
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

function requestAt(callIndex: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[callIndex] as [string, RequestInit]
  return { url: call[0], init: call[1] }
}

function bodyAt(callIndex: number): Record<string, unknown> {
  return JSON.parse(requestAt(callIndex).init.body as string) as Record<string, unknown>
}

const pageRef = { remoteType: 'page', remoteId: '98765' }

const currentPage = {
  id: '98765',
  title: 'Release plan',
  status: 'current',
  version: { number: 4 },
  body: { storage: { value: '<p>old body</p>' } },
}

function pageListResponse(
  pages: Array<{ id: string; title: string }>,
  next?: string,
): Record<string, unknown> {
  return {
    results: pages.map((p) => ({
      id: p.id,
      title: p.title,
      status: 'current',
      spaceId: '111',
      version: { number: 1, createdAt: '2026-06-01T00:00:00Z' },
      _links: { webui: `/spaces/ENG/pages/${p.id}` },
    })),
    _links: next ? { next } : {},
  }
}

describe('ConfluenceConnector — fetchEntities pagination', () => {
  it('extracts the cursor TOKEN from the relative _links.next URL (not the URL itself)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pageListResponse(
      [{ id: '1', title: 'Page one' }],
      '/wiki/api/v2/pages?cursor=eyJpZCI6MX0&limit=25',
    )))

    const { entities, nextCursor } = await connector().fetchEntities()

    expect(entities).toHaveLength(1)
    // The bug: returning the whole relative URL here made the next request
    // send cursor=/wiki/api/v2/pages?... → 400 → sync stopped at 25 items.
    expect(nextCursor).toBe('eyJpZCI6MX0')
  })

  it('round-trips the cursor token back as the cursor query param (sync-engine loop)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pageListResponse(
        [{ id: '1', title: 'Page one' }],
        '/wiki/api/v2/pages?cursor=tok-page-2&limit=25',
      )))
      .mockResolvedValueOnce(jsonResponse(pageListResponse([{ id: '2', title: 'Page two' }])))

    const conn = connector()
    // Mirror the sync engine's do/while: feed nextCursor back until null
    const all: string[] = []
    let cursor: string | undefined
    do {
      const { entities, nextCursor } = await conn.fetchEntities(cursor)
      all.push(...entities.map((e) => e.entityId))
      cursor = nextCursor ?? undefined
    } while (cursor)

    expect(all).toEqual(['1', '2'])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const second = new URL(requestAt(1).url)
    expect(second.pathname).toBe('/wiki/api/v2/pages')
    expect(second.searchParams.get('cursor')).toBe('tok-page-2')
  })

  it('returns a null cursor on the last page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pageListResponse([{ id: '1', title: 'Only page' }])))

    const { nextCursor } = await connector().fetchEntities()
    expect(nextCursor).toBeNull()
  })

  it('stores the numeric space id under raw.spaceId (not spaceKey)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(pageListResponse([{ id: '1', title: 'Page one' }])))

    const { entities } = await connector().fetchEntities()
    expect(entities[0]?.raw['spaceId']).toBe('111')
    expect(entities[0]?.raw).not.toHaveProperty('spaceKey')
  })
})

describe('ConfluenceConnector — listResources (spaces)', () => {
  it('follows _links.next across pages and accumulates all spaces', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 1, key: 'ENG', name: 'Engineering' }],
        _links: { next: '/wiki/api/v2/spaces?cursor=sp-2&limit=250' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 2, key: 'OPS', name: 'Operations' }],
        _links: {},
      }))

    const spaces = await connector().listResources()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestAt(0).url).toBe(`${BASE_URL}/wiki/api/v2/spaces?limit=250`)
    // The relative next link is fetched against the site base URL
    expect(requestAt(1).url).toBe(`${BASE_URL}/wiki/api/v2/spaces?cursor=sp-2&limit=250`)

    expect(spaces).toEqual([
      { id: '1', label: 'Engineering', sublabel: 'ENG', metadata: { spaceId: '1' } },
      { id: '2', label: 'Operations', sublabel: 'OPS', metadata: { spaceId: '2' } },
    ])
  })

  it('stops at a single page when there is no next link', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [{ id: 1, key: 'ENG', name: 'Engineering' }],
    }))

    const spaces = await connector().listResources()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(spaces).toHaveLength(1)
  })
})

describe('ConfluenceConnector — capabilities', () => {
  it('declares item-level writes only (no board mirror)', () => {
    expect(connector().capabilities).toEqual({ write: ['update_item', 'comment', 'close_item'] })
  })
})

describe('ConfluenceConnector — update_item', () => {
  it('reads the current version then PUTs version+1 with the patched title/body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(currentPage))
      .mockResolvedValueOnce(jsonResponse({ ...currentPage, title: 'New title', version: { number: 5 } }))

    const result = await connector().applyMutation(envelope({
      kind: 'update_item',
      ref: pageRef,
      patch: { title: 'New title', body: '<p>new body</p>' },
    }))

    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 1st call: version read (with storage body so unpatched fields survive)
    const read = requestAt(0)
    expect(read.url).toBe(`${BASE_URL}/wiki/api/v2/pages/98765?body-format=storage`)
    expect(read.init.method).toBeUndefined()

    // 2nd call: optimistic-locked PUT
    const put = requestAt(1)
    expect(put.url).toBe(`${BASE_URL}/wiki/api/v2/pages/98765`)
    expect(put.init.method).toBe('PUT')
    expect(bodyAt(1)).toEqual({
      id: '98765',
      status: 'current',
      title: 'New title',
      body: { representation: 'storage', value: '<p>new body</p>' },
      version: { number: 5 },
    })

    expect(result.remoteVersion).toBe('5')
    expect(result.ref).toEqual(pageRef)
  })

  it('preserves the current title and body for fields the patch omits', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(currentPage))
      .mockResolvedValueOnce(jsonResponse({ ...currentPage, version: { number: 5 } }))

    await connector().applyMutation(envelope({
      kind: 'update_item',
      ref: pageRef,
      patch: { body: '<p>only body changed</p>' },
    }))

    const body = bodyAt(1)
    expect(body['title']).toBe('Release plan')
    expect(body['body']).toEqual({ representation: 'storage', value: '<p>only body changed</p>' })
  })

  it('surfaces a stale-version 409 from the PUT as an error (conflict)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(currentPage))
      .mockResolvedValueOnce(jsonResponse({ message: 'version conflict' }, 409))

    await expect(connector().applyMutation(envelope({
      kind: 'update_item',
      ref: pageRef,
      patch: { title: 'Too late' },
    }))).rejects.toThrow('HTTP 409')
  })
})

describe('ConfluenceConnector — comment', () => {
  it('POSTs a storage-format footer comment to the page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '555' }))

    const result = await connector().applyMutation(envelope({
      kind: 'comment',
      ref: pageRef,
      body: '<p>Looks good — shipping.</p>',
    }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const post = requestAt(0)
    expect(post.url).toBe(`${BASE_URL}/wiki/api/v2/pages/98765/footer-comments`)
    expect(post.init.method).toBe('POST')
    expect(bodyAt(0)).toEqual({
      body: { representation: 'storage', value: '<p>Looks good — shipping.</p>' },
    })

    // Comments don't bump the page version
    expect(result.remoteVersion).toBeNull()
    expect(result.raw['commentId']).toBe('555')
  })
})

describe('ConfluenceConnector — close_item (archive)', () => {
  // The v2 page update endpoint only accepts status current/draft — archiving
  // must go through the v1 bulk-archive endpoint, in a single POST.
  it('POSTs the page id to the v1 archive endpoint (no read-then-PUT)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'task-42' }, 202))

    const result = await connector().applyMutation(envelope({ kind: 'close_item', ref: pageRef }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const post = requestAt(0)
    expect(post.url).toBe(`${BASE_URL}/wiki/rest/api/content/archive`)
    expect(post.init.method).toBe('POST')
    expect(bodyAt(0)).toEqual({ pages: [{ id: '98765' }] })

    // Archiving doesn't bump the page version
    expect(result.remoteVersion).toBeNull()
    expect(result.ref).toEqual(pageRef)
    expect(result.raw).toEqual({ archived: true, taskId: 'task-42' })
  })

  it('never PUTs status=archived at the v2 update endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'task-42' }, 202))

    await connector().applyMutation(envelope({ kind: 'close_item', ref: pageRef }))

    expect(requestAt(0).url).not.toContain('/wiki/api/v2/pages')
  })

  it('surfaces an archive failure as an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'no permission' }, 400))

    await expect(connector().applyMutation(envelope({ kind: 'close_item', ref: pageRef })))
      .rejects.toThrow('HTTP 400')
  })
})

describe('ConfluenceConnector — unsupported mutations', () => {
  it('throws UnsupportedMutationError for kinds outside its capability set', async () => {
    await expect(connector().applyMutation(envelope({
      kind: 'move_item',
      ref: pageRef,
      toStatusRemoteId: 'col-1',
    }))).rejects.toBeInstanceOf(UnsupportedMutationError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails loudly when the connector has no baseUrl', async () => {
    const noBase = new ConfluenceConnector({
      credentialId: 'cred-1',
      projectId: 'proj-1',
      token: 'api-token',
    })
    await expect(noBase.applyMutation(envelope({
      kind: 'comment',
      ref: pageRef,
      body: '<p>hi</p>',
    }))).rejects.toThrow('missing baseUrl')
  })
})
