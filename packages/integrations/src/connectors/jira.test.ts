import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stableHash } from '@creare/shared'
import { JiraConnector, JIRA_STATUS_FIELD } from './jira'
import type { ConnectorConfig, MutationEnvelope, MutationOp } from '../types'

// All tests mock global fetch — no real network, ever.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = 'https://acme.atlassian.net'

const config: ConnectorConfig = {
  credentialId: 'cred-1',
  projectId: 'proj-1',
  token: 'api-token',
  baseUrl: BASE,
  metadata: { email: 'pm@acme.dev' },
}

const connector = () => new JiraConnector(config)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 })
}

function envelope(op: MutationOp): MutationEnvelope {
  return { opId: 'op-1', credentialId: 'cred-1', projectId: 'proj-1', source: 'jira', baseVersion: null, op }
}

function requestAt(callIndex: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[callIndex] as [string, RequestInit]
  return { url: call[0], init: call[1] }
}

function requestBody(callIndex: number): Record<string, unknown> {
  return JSON.parse(requestAt(callIndex).init.body as string) as Record<string, unknown>
}

const versionResponse = (updated = '2026-06-11T15:00:00.000+0000') =>
  jsonResponse({ fields: { updated } })

// ── listRemoteBoards ─────────────────────────────────────────────────────────

describe('JiraConnector — listRemoteBoards', () => {
  it('maps Jira projects to RemoteBoardOption with browse URLs and sends Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        values: [
          { id: '10001', key: 'CRE', name: 'Creare' },
          { id: '10002', key: 'OPS', name: 'Platform Ops' },
        ],
      }),
    )

    const boards = await connector().listRemoteBoards()

    expect(boards).toEqual([
      { id: 'CRE', label: 'Creare', sublabel: 'CRE', url: `${BASE}/browse/CRE` },
      { id: 'OPS', label: 'Platform Ops', sublabel: 'OPS', url: `${BASE}/browse/OPS` },
    ])

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/project/search?maxResults=100`)
    const headers = init.headers as Record<string, string>
    const expectedAuth = `Basic ${Buffer.from('pm@acme.dev:api-token').toString('base64')}`
    expect(headers['Authorization']).toBe(expectedAuth)
  })

  it('returns [] when baseUrl is missing', async () => {
    const { baseUrl: _omitted, ...rest } = config
    const bare = new JiraConnector(rest)
    await expect(bare.listRemoteBoards()).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── fetchBoardSnapshot ───────────────────────────────────────────────────────

describe('JiraConnector — fetchBoardSnapshot', () => {
  it('builds columns from statuses (deduped, category-ordered, done=terminal) and items from issues', async () => {
    fetchMock
      // 1. project lookup
      .mockResolvedValueOnce(jsonResponse({ id: '10001', key: 'CRE', name: 'Creare' }))
      // 2. statuses per issue type — scrambled order + a duplicate across types
      .mockResolvedValueOnce(
        jsonResponse([
          {
            name: 'Task',
            statuses: [
              { id: '3', name: 'Done', statusCategory: { key: 'done' } },
              { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
              { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            ],
          },
          {
            name: 'Bug',
            statuses: [
              { id: '1', name: 'To Do', statusCategory: { key: 'new' } }, // dupe
              { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } },
            ],
          },
        ]),
      )
      // 3. issue search — fewer than a full page, so pagination stops
      .mockResolvedValueOnce(
        jsonResponse({
          total: 2,
          issues: [
            {
              key: 'CRE-2',
              fields: {
                summary: 'Ship the mirror',
                updated: '2026-06-11T12:00:00.000+0000',
                status: { id: '2', statusCategory: { key: 'indeterminate' } },
              },
            },
            {
              key: 'CRE-1',
              fields: {
                summary: 'Old bug',
                updated: '2026-06-10T08:00:00.000+0000',
                status: { id: '3', statusCategory: { key: 'done' } },
              },
            },
          ],
        }),
      )

    const snapshot = await connector().fetchBoardSnapshot('CRE')

    expect(snapshot.remoteId).toBe('CRE')
    expect(snapshot.title).toBe('Creare')
    expect(snapshot.url).toBe(`${BASE}/browse/CRE`)
    expect(snapshot.statusFieldRemoteId).toBe(JIRA_STATUS_FIELD)
    // Board version = newest issue update (Jira projects have no updatedAt)
    expect(snapshot.version).toBe('2026-06-11T12:00:00.000+0000')

    // Columns: To Do < In Progress < Done by category, discovery order within;
    // status 1 deduped across the two issue types
    expect(snapshot.columns).toEqual([
      { remoteId: '1', name: 'To Do', position: 0, isTerminal: false },
      { remoteId: '2', name: 'In Progress', position: 1, isTerminal: false },
      { remoteId: '4', name: 'In Review', position: 2, isTerminal: false },
      { remoteId: '3', name: 'Done', position: 3, isTerminal: true },
    ])

    expect(snapshot.items).toEqual([
      {
        remoteId: 'CRE-2',
        containerRemoteId: 'CRE',
        title: 'Ship the mirror',
        url: `${BASE}/browse/CRE-2`,
        statusRemoteId: '2',
        state: 'open',
        archived: false,
        version: '2026-06-11T12:00:00.000+0000',
        contentHash: stableHash({ title: 'Ship the mirror', statusRemoteId: '2', state: 'open', archived: false }),
      },
      {
        remoteId: 'CRE-1',
        containerRemoteId: 'CRE',
        title: 'Old bug',
        url: `${BASE}/browse/CRE-1`,
        statusRemoteId: '3',
        state: 'closed', // done-category status → closed
        archived: false,
        version: '2026-06-10T08:00:00.000+0000',
        contentHash: stableHash({ title: 'Old bug', statusRemoteId: '3', state: 'closed', archived: false }),
      },
    ])

    // Request shape: search JQL scoped to the project, newest-updated first
    const searchUrl = requestAt(2).url
    expect(searchUrl).toContain('/rest/api/3/search?jql=')
    expect(searchUrl).toContain(encodeURIComponent('project = CRE ORDER BY updated DESC'))
    expect(searchUrl).toContain('fields=summary,status,updated')
  })

  it('paginates a second page when the first is full and more issues exist', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      key: `CRE-${i + 1}`,
      fields: {
        summary: `Issue ${i + 1}`,
        updated: '2026-06-11T00:00:00.000+0000',
        status: { id: '1', statusCategory: { key: 'new' } },
      },
    }))

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '10001', key: 'CRE', name: 'Creare' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Task', statuses: [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }] }]))
      .mockResolvedValueOnce(jsonResponse({ total: 150, issues: fullPage }))
      .mockResolvedValueOnce(
        jsonResponse({
          total: 150,
          issues: [{
            key: 'CRE-101',
            fields: { summary: 'Tail issue', updated: '2026-06-09T00:00:00.000+0000', status: { id: '1', statusCategory: { key: 'new' } } },
          }],
        }),
      )

    const snapshot = await connector().fetchBoardSnapshot('CRE')

    expect(snapshot.items).toHaveLength(101)
    expect(requestAt(2).url).toContain('startAt=0')
    expect(requestAt(3).url).toContain('startAt=100')
  })

  it('throws when the project is not visible to this token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: ['No project'] }, 404))
    await expect(connector().fetchBoardSnapshot('NOPE')).rejects.toThrow(/not found|not visible/)
  })
})

// ── capabilities ─────────────────────────────────────────────────────────────

describe('JiraConnector — capabilities', () => {
  it('advertises the Phase 3 write set', () => {
    expect(connector().capabilities).toEqual({
      write: ['move_item', 'create_item', 'update_item', 'comment', 'close_item'],
    })
  })
})

// ── applyMutation: move_item ─────────────────────────────────────────────────

describe('JiraConnector — applyMutation move_item', () => {
  const moveOp: MutationOp = {
    kind: 'move_item',
    ref: { remoteType: 'ticket', remoteId: 'CRE-7', containerId: 'CRE' },
    toStatusRemoteId: '3',
    statusFieldRemoteId: JIRA_STATUS_FIELD,
  }

  it('looks up transitions, fires the one landing on the target status, and returns the fresh version', async () => {
    fetchMock
      // 1. GET transitions
      .mockResolvedValueOnce(
        jsonResponse({
          transitions: [
            { id: '11', name: 'Start work', to: { id: '2', statusCategory: { key: 'indeterminate' } } },
            { id: '31', name: 'Finish', to: { id: '3', statusCategory: { key: 'done' } } },
          ],
        }),
      )
      // 2. POST transition
      .mockResolvedValueOnce(noContentResponse())
      // 3. version read-back
      .mockResolvedValueOnce(versionResponse('2026-06-11T16:00:00.000+0000'))

    const result = await connector().applyMutation(envelope(moveOp))

    expect(requestAt(0).url).toBe(`${BASE}/rest/api/3/issue/CRE-7/transitions`)
    const post = requestAt(1)
    expect(post.url).toBe(`${BASE}/rest/api/3/issue/CRE-7/transitions`)
    expect(post.init.method).toBe('POST')
    expect(requestBody(1)).toEqual({ transition: { id: '31' } })

    expect(result.ref).toEqual(moveOp.ref)
    expect(result.remoteVersion).toBe('2026-06-11T16:00:00.000+0000')
    expect(result.remoteUrl).toBe(`${BASE}/browse/CRE-7`)
    expect(result.raw).toMatchObject({ transitionId: '31' })
  })

  it('throws a clear fatal error when the workflow allows no transition to the target status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        transitions: [{ id: '11', name: 'Start work', to: { id: '2', statusCategory: { key: 'indeterminate' } } }],
      }),
    )

    await expect(connector().applyMutation(envelope(moveOp))).rejects.toThrow(
      /no Jira transition .* to status 3 — move it in Jira/,
    )
    // No transition POST was attempted
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ── applyMutation: create_item ───────────────────────────────────────────────

describe('JiraConnector — applyMutation create_item', () => {
  it('POSTs a new issue with project key, summary, issue type, and ADF description', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '10100', key: 'CRE-42' }, 201))
      .mockResolvedValueOnce(versionResponse('2026-06-11T17:00:00.000+0000'))

    const result = await connector().applyMutation(envelope({
      kind: 'create_item',
      container: { remoteType: 'project', remoteId: 'CRE' },
      title: 'Wire up Jira mirror',
      body: 'Phase 3 slice',
    }))

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/issue`)
    expect(init.method).toBe('POST')
    expect(requestBody(0)).toEqual({
      fields: {
        project: { key: 'CRE' },
        summary: 'Wire up Jira mirror',
        issuetype: { name: 'Task' },
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Phase 3 slice' }] }],
        },
      },
    })

    expect(result.ref).toEqual({ remoteType: 'ticket', remoteId: 'CRE-42', containerId: 'CRE' })
    expect(result.remoteVersion).toBe('2026-06-11T17:00:00.000+0000')
    expect(result.remoteUrl).toBe(`${BASE}/browse/CRE-42`)
  })

  it('omits description and honors a custom itemType when body is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '10101', key: 'CRE-43' }, 201))
      .mockResolvedValueOnce(versionResponse())

    await connector().applyMutation(envelope({
      kind: 'create_item',
      container: { remoteType: 'project', remoteId: 'CRE' },
      title: 'Bare task',
      itemType: 'Bug',
    }))

    expect(requestBody(0)).toEqual({
      fields: { project: { key: 'CRE' }, summary: 'Bare task', issuetype: { name: 'Bug' } },
    })
  })
})

// ── applyMutation: update_item ───────────────────────────────────────────────

describe('JiraConnector — applyMutation update_item', () => {
  it('PUTs the new summary', async () => {
    fetchMock
      .mockResolvedValueOnce(noContentResponse())
      .mockResolvedValueOnce(versionResponse('2026-06-11T18:00:00.000+0000'))

    const result = await connector().applyMutation(envelope({
      kind: 'update_item',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
      patch: { title: 'Renamed ticket' },
    }))

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/issue/CRE-7`)
    expect(init.method).toBe('PUT')
    expect(requestBody(0)).toEqual({ fields: { summary: 'Renamed ticket' } })
    expect(result.remoteVersion).toBe('2026-06-11T18:00:00.000+0000')
  })

  it('rejects patches without a title', async () => {
    await expect(connector().applyMutation(envelope({
      kind: 'update_item',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
      patch: { body: 'new body' },
    }))).rejects.toThrow(/title .* only/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── applyMutation: comment ───────────────────────────────────────────────────

describe('JiraConnector — applyMutation comment', () => {
  it('POSTs an ADF comment body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '9001' }, 201))
      .mockResolvedValueOnce(versionResponse())

    const result = await connector().applyMutation(envelope({
      kind: 'comment',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
      body: 'Looks good to me',
    }))

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/issue/CRE-7/comment`)
    expect(init.method).toBe('POST')
    expect(requestBody(0)).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good to me' }] }],
      },
    })
    expect(result.raw).toEqual({ commentId: '9001' })
  })
})

// ── applyMutation: close_item ────────────────────────────────────────────────

describe('JiraConnector — applyMutation close_item', () => {
  it('transitions to the first Done-category transition', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          transitions: [
            { id: '11', name: 'Start work', to: { id: '2', statusCategory: { key: 'indeterminate' } } },
            { id: '31', name: 'Finish', to: { id: '3', statusCategory: { key: 'done' } } },
          ],
        }),
      )
      .mockResolvedValueOnce(noContentResponse())
      .mockResolvedValueOnce(versionResponse())

    const result = await connector().applyMutation(envelope({
      kind: 'close_item',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
    }))

    expect(requestBody(1)).toEqual({ transition: { id: '31' } })
    expect(result.raw).toMatchObject({ transitionId: '31' })
  })

  it('throws when no Done-category transition is reachable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        transitions: [{ id: '11', name: 'Start work', to: { id: '2', statusCategory: { key: 'indeterminate' } } }],
      }),
    )

    await expect(connector().applyMutation(envelope({
      kind: 'close_item',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
    }))).rejects.toThrow(/no Jira transition to a Done-category status/)
  })
})

// ── applyMutation: unsupported kinds ─────────────────────────────────────────

describe('JiraConnector — applyMutation unsupported kinds', () => {
  it('throws UnsupportedMutationError for reopen_item', async () => {
    await expect(connector().applyMutation(envelope({
      kind: 'reopen_item',
      ref: { remoteType: 'ticket', remoteId: 'CRE-7' },
    }))).rejects.toThrow(/does not support the "reopen_item" mutation/)
  })
})
