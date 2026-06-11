import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OneDriveConnector } from './onedrive'
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

function connector(): OneDriveConnector {
  return new OneDriveConnector({
    credentialId: 'cred-1',
    projectId: 'proj-1',
    token: 'graph-token',
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

function requestAt(callIndex: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[callIndex] as [string, RequestInit]
  return { url: call[0], init: call[1] }
}

function bodyAt(callIndex: number): Record<string, unknown> {
  return JSON.parse(requestAt(callIndex).init.body as string) as Record<string, unknown>
}

const fileRef = { remoteType: 'file', remoteId: 'item-abc' }

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

  it('surfaces a failed precondition (412 stale eTag) as an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'resourceModified' } }, 412))

    await expect(connector().applyMutation(envelope(
      { kind: 'move_item', ref: fileRef, toStatusRemoteId: 'folder-xyz' },
      '"stale-etag"',
    ))).rejects.toThrow('HTTP 412')
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
