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
  it('reads the current version then PUTs status=archived with a version bump', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(currentPage))
      .mockResolvedValueOnce(jsonResponse({ ...currentPage, status: 'archived', version: { number: 5 } }))

    const result = await connector().applyMutation(envelope({ kind: 'close_item', ref: pageRef }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const put = requestAt(1)
    expect(put.url).toBe(`${BASE_URL}/wiki/api/v2/pages/98765`)
    expect(put.init.method).toBe('PUT')

    const body = bodyAt(1)
    expect(body['status']).toBe('archived')
    expect(body['version']).toEqual({ number: 5 })
    // Title and body carry over unchanged
    expect(body['title']).toBe('Release plan')
    expect(body['body']).toEqual({ representation: 'storage', value: '<p>old body</p>' })

    expect(result.remoteVersion).toBe('5')
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
