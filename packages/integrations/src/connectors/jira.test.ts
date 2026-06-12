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
        isLast: true,
      }),
    )

    const boards = await connector().listRemoteBoards()

    expect(boards).toEqual([
      { id: 'CRE', label: 'Creare', sublabel: 'CRE', url: `${BASE}/browse/CRE` },
      { id: 'OPS', label: 'Platform Ops', sublabel: 'OPS', url: `${BASE}/browse/OPS` },
    ])

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/project/search?startAt=0&maxResults=50`)
    const headers = init.headers as Record<string, string>
    const expectedAuth = `Basic ${Buffer.from('pm@acme.dev:api-token').toString('base64')}`
    expect(headers['Authorization']).toBe(expectedAuth)
  })

  it('paginates project/search with startAt until isLast and accumulates all pages', async () => {
    const page = (offset: number, count: number, isLast: boolean) => ({
      values: Array.from({ length: count }, (_, i) => ({
        id: `${10000 + offset + i}`,
        key: `P${offset + i}`,
        name: `Project ${offset + i}`,
      })),
      isLast,
    })

    fetchMock
      .mockResolvedValueOnce(jsonResponse(page(0, 50, false)))
      .mockResolvedValueOnce(jsonResponse(page(50, 50, false)))
      .mockResolvedValueOnce(jsonResponse(page(100, 7, true)))

    const boards = await connector().listRemoteBoards()

    expect(boards).toHaveLength(107)
    expect(boards[0]?.id).toBe('P0')
    expect(boards[106]?.id).toBe('P106')
    expect(requestAt(0).url).toBe(`${BASE}/rest/api/3/project/search?startAt=0&maxResults=50`)
    expect(requestAt(1).url).toBe(`${BASE}/rest/api/3/project/search?startAt=50&maxResults=50`)
    expect(requestAt(2).url).toBe(`${BASE}/rest/api/3/project/search?startAt=100&maxResults=50`)
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
      // 3. issue search — isLast with no nextPageToken, so pagination stops
      .mockResolvedValueOnce(
        jsonResponse({
          isLast: true,
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

    // Request shape: POST /search/jql (the old GET /search is gone from Jira
    // Cloud), JQL scoped to the QUOTED project key, newest-updated first
    const search = requestAt(2)
    expect(search.url).toBe(`${BASE}/rest/api/3/search/jql`)
    expect(search.init.method).toBe('POST')
    expect(requestBody(2)).toEqual({
      jql: 'project = "CRE" ORDER BY updated DESC',
      maxResults: 100,
      fields: ['summary', 'status', 'updated'],
    })
  })

  it('paginates a second page via nextPageToken and stops when the token disappears', async () => {
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
      .mockResolvedValueOnce(jsonResponse({ issues: fullPage, nextPageToken: 'tok-page-2', isLast: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          isLast: true,
          issues: [{
            key: 'CRE-101',
            fields: { summary: 'Tail issue', updated: '2026-06-09T00:00:00.000+0000', status: { id: '1', statusCategory: { key: 'new' } } },
          }],
        }),
      )

    const snapshot = await connector().fetchBoardSnapshot('CRE')

    expect(snapshot.items).toHaveLength(101)
    // First page carries no token; the second echoes the server's cursor
    expect(requestBody(2)['nextPageToken']).toBeUndefined()
    expect(requestBody(3)['nextPageToken']).toBe('tok-page-2')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('quotes the project key in JQL so a crafted key cannot inject clauses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: '10001', key: 'CRE" OR project != "X', name: 'Evil' }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ issues: [], isLast: true }))

    await connector().fetchBoardSnapshot('EVIL')

    // Embedded quotes are stripped; the key stays inside one quoted literal
    expect(requestBody(2)['jql']).toBe('project = "CRE OR project != X" ORDER BY updated DESC')
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
  it('prefers the Done-category transition whose target status reads Done/Complete', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          transitions: [
            // Done-category but NOT a completion — must lose to "Done" below
            { id: '21', name: 'Abandon', to: { id: '5', name: "Won't Do", statusCategory: { key: 'done' } } },
            { id: '31', name: 'Finish', to: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
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

  it('falls back to the first Done-category transition when none reads Done/Complete', async () => {
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

// ── fetchEntities ────────────────────────────────────────────────────────────

describe('JiraConnector — fetchEntities', () => {
  const issue = (key: string) => ({
    key,
    fields: {
      summary: `Summary of ${key}`,
      updated: '2026-06-11T12:00:00.000+0000',
      labels: ['sync'],
      assignee: { displayName: 'Bruna' },
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      priority: { name: 'High' },
    },
  })

  it('POSTs /search/jql, normalizes issues, and returns nextPageToken as the cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ issues: [issue('CRE-1')], nextPageToken: 'tok-abc', isLast: false }),
    )

    const result = await connector().fetchEntities()

    const { url, init } = requestAt(0)
    expect(url).toBe(`${BASE}/rest/api/3/search/jql`)
    expect(init.method).toBe('POST')
    expect(requestBody(0)).toEqual({
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      maxResults: 50,
      fields: ['summary', 'status', 'assignee', 'updated', 'labels', 'priority'],
    })

    expect(result.nextCursor).toBe('tok-abc')
    expect(result.entities).toEqual([{
      source: 'jira',
      entityType: 'ticket',
      entityId: 'CRE-1',
      entityUrl: `${BASE}/browse/CRE-1`,
      title: 'Summary of CRE-1',
      status: 'In Progress',
      assignee: 'Bruna',
      updatedAt: '2026-06-11T12:00:00.000+0000',
      raw: { key: 'CRE-1', labels: ['sync'], priority: 'High', statusCategory: 'In Progress' },
    }])
  })

  it('passes the incoming cursor through as nextPageToken and ends on isLast', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ issues: [issue('CRE-2')], isLast: true }),
    )

    const result = await connector().fetchEntities('tok-abc')

    expect(requestBody(0)['nextPageToken']).toBe('tok-abc')
    expect(result.entities).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })

  it('scopes and QUOTES the JQL when a projectKey is bound to the source', async () => {
    const scoped = new JiraConnector({
      ...config,
      metadata: { email: 'pm@acme.dev', projectKey: 'CRE" OR project != "X' },
    })
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [], isLast: true }))

    await scoped.fetchEntities()

    expect(requestBody(0)['jql']).toBe(
      'project = "CRE OR project != X" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    )
  })

  it('returns empty without fetching when baseUrl is missing', async () => {
    const { baseUrl: _omitted, ...rest } = config
    const bare = new JiraConnector(rest)
    await expect(bare.fetchEntities()).resolves.toEqual({ entities: [], nextCursor: null })
    expect(fetchMock).not.toHaveBeenCalled()
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
