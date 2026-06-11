import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stableHash } from '@creare/shared'
import {
  GitHubProjectsClient,
  GitHubRateLimitError,
  GitHubScopeError,
  GitHubNotFoundError,
} from './github-projects'

// All tests mock global fetch — no real network, ever.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function dataResponse(data: unknown): Response {
  return jsonResponse({ data })
}

function errorsResponse(errors: Array<{ type: string; message?: string }>, headers: Record<string, string> = {}): Response {
  return jsonResponse({ data: null, errors }, 200, headers)
}

function requestBody(callIndex: number): { query: string; variables: Record<string, unknown> } {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit
  return JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> }
}

const client = () => new GitHubProjectsClient('test-token')

// ── graphql() error classification ──────────────────────────────────────────
// GraphQL returns HTTP 200 with a top-level errors[] for most failures —
// classification must come from errors[].type, not the HTTP status.

describe('GitHubProjectsClient — graphql error classification', () => {
  it('throws a retryable GitHubRateLimitError on 200 + RATE_LIMITED, honoring Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      errorsResponse([{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }], { 'retry-after': '30' }),
    )

    const err = await client().listProjects().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubRateLimitError)
    expect((err as GitHubRateLimitError).retryable).toBe(true)
    expect((err as GitHubRateLimitError).retryAfterMs).toBe(30_000)
  })

  it('throws a fatal GitHubScopeError on 200 + INSUFFICIENT_SCOPES', async () => {
    fetchMock.mockResolvedValueOnce(
      errorsResponse([{ type: 'INSUFFICIENT_SCOPES', message: 'token needs project scope' }]),
    )
    await expect(client().listProjects()).rejects.toBeInstanceOf(GitHubScopeError)
  })

  it('throws a fatal GitHubScopeError on 200 + FORBIDDEN', async () => {
    fetchMock.mockResolvedValueOnce(errorsResponse([{ type: 'FORBIDDEN', message: 'forbidden' }]))
    await expect(client().listProjects()).rejects.toBeInstanceOf(GitHubScopeError)
  })

  it('throws GitHubNotFoundError on 200 + NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'no such node' }]))
    await expect(client().listProjects()).rejects.toBeInstanceOf(GitHubNotFoundError)
  })

  it('throws GitHubScopeError on HTTP 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(client().listProjects()).rejects.toBeInstanceOf(GitHubScopeError)
  })

  it('throws a plain error on other non-2xx HTTP statuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad request' }, 400))
    await expect(client().listProjects()).rejects.toThrow(/HTTP 400/)
  })

  it('fetchItemVersion treats NOT_FOUND as null (vanished item = unknown version)', async () => {
    fetchMock.mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'gone' }]))
    await expect(client().fetchItemVersion('PVTI_gone')).resolves.toBeNull()
  })

  it('sends the bearer token and Accept header', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ viewer: { projectsV2: { nodes: [] }, organizations: { nodes: [] } } }),
    )
    await client().listProjects()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token')
    expect(headers['Accept']).toBe('application/vnd.github+json')
  })
})

// ── listProjects ────────────────────────────────────────────────────────────

describe('GitHubProjectsClient — listProjects', () => {
  it('maps viewer and org projects to RemoteBoardOption, deduplicating by id', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        viewer: {
          projectsV2: {
            nodes: [
              { id: 'PVT_1', title: 'Personal Roadmap', number: 3, url: 'https://github.com/users/me/projects/3' },
              null, // GraphQL list elements can be null
            ],
          },
          organizations: {
            nodes: [
              {
                login: 'acme',
                projectsV2: {
                  nodes: [
                    { id: 'PVT_2', title: 'Acme Sprint', number: 7, url: 'https://github.com/orgs/acme/projects/7' },
                    { id: 'PVT_1', title: 'Personal Roadmap', number: 3, url: 'https://github.com/users/me/projects/3' }, // dupe
                  ],
                },
              },
              null,
            ],
          },
        },
      }),
    )

    const options = await client().listProjects()

    expect(options).toEqual([
      { id: 'PVT_1', label: 'Personal Roadmap', sublabel: '#3', url: 'https://github.com/users/me/projects/3' },
      { id: 'PVT_2', label: 'Acme Sprint', sublabel: '#7', url: 'https://github.com/orgs/acme/projects/7' },
    ])
  })
})

// ── fetchProjectSnapshot ────────────────────────────────────────────────────

const STATUS_FIELD = {
  id: 'FIELD_STATUS',
  options: [
    { id: 'opt-todo', name: 'Todo' },
    { id: 'opt-prog', name: 'In Progress' },
    { id: 'opt-done', name: 'Done' },
  ],
}

function projectPage(items: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }, field: unknown = STATUS_FIELD) {
  return dataResponse({
    node: {
      id: 'PVT_1',
      title: 'Roadmap',
      url: 'https://github.com/orgs/acme/projects/1',
      updatedAt: '2026-06-11T10:00:00Z',
      field,
      items: { pageInfo, nodes: items },
    },
  })
}

describe('GitHubProjectsClient — fetchProjectSnapshot', () => {
  it('paginates items, builds columns with terminal detection, and hashes item content', async () => {
    fetchMock
      .mockResolvedValueOnce(
        projectPage(
          [
            {
              id: 'ITEM_1', isArchived: false, updatedAt: '2026-06-10T09:00:00Z',
              fieldValueByName: { optionId: 'opt-todo' },
              content: { __typename: 'Issue', title: 'Fix login', url: 'https://github.com/acme/app/issues/1', state: 'OPEN' },
            },
            {
              id: 'ITEM_2', isArchived: false, updatedAt: '2026-06-10T10:00:00Z',
              fieldValueByName: null,
              content: { __typename: 'PullRequest', title: 'Add API', url: 'https://github.com/acme/app/pull/2', state: 'OPEN', isDraft: true },
            },
          ],
          { hasNextPage: true, endCursor: 'cursor-1' },
        ),
      )
      .mockResolvedValueOnce(
        projectPage(
          [
            {
              id: 'ITEM_3', isArchived: true, updatedAt: '2026-06-10T11:00:00Z',
              fieldValueByName: { optionId: 'opt-done' },
              content: { __typename: 'DraftIssue', title: 'Draft note' },
            },
            // content null = invisible to this token → skipped, not mirrored
            { id: 'ITEM_4', isArchived: false, updatedAt: '2026-06-10T12:00:00Z', fieldValueByName: null, content: null },
          ],
          { hasNextPage: false, endCursor: null },
        ),
      )

    const snapshot = await client().fetchProjectSnapshot('PVT_1')

    // Pagination: two requests, second carries the cursor from page one
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(0).variables).toEqual({ projectId: 'PVT_1', cursor: null })
    expect(requestBody(1).variables).toEqual({ projectId: 'PVT_1', cursor: 'cursor-1' })

    expect(snapshot.remoteId).toBe('PVT_1')
    expect(snapshot.title).toBe('Roadmap')
    expect(snapshot.version).toBe('2026-06-11T10:00:00Z')
    expect(snapshot.statusFieldRemoteId).toBe('FIELD_STATUS')

    // Columns: position = option index; "Done" matches the terminal regex
    expect(snapshot.columns).toEqual([
      { remoteId: 'opt-todo', name: 'Todo', position: 0, isTerminal: false },
      { remoteId: 'opt-prog', name: 'In Progress', position: 1, isTerminal: false },
      { remoteId: 'opt-done', name: 'Done', position: 2, isTerminal: true },
    ])

    // Items: null-content item skipped
    expect(snapshot.items.map((i) => i.remoteId)).toEqual(['ITEM_1', 'ITEM_2', 'ITEM_3'])

    const [issue, draftPr, draftIssue] = snapshot.items
    expect(issue).toMatchObject({
      containerRemoteId: 'PVT_1', title: 'Fix login', state: 'open',
      statusRemoteId: 'opt-todo', archived: false, version: '2026-06-10T09:00:00Z',
    })
    expect(issue!.contentHash).toBe(
      stableHash({ title: 'Fix login', statusRemoteId: 'opt-todo', state: 'open', archived: false }),
    )
    expect(draftPr).toMatchObject({ state: 'draft', statusRemoteId: null })
    expect(draftIssue).toMatchObject({ state: 'draft', statusRemoteId: 'opt-done', archived: true, url: null })
  })

  it('falls back to marking the LAST option terminal when no name matches the done-ish regex', async () => {
    fetchMock.mockResolvedValueOnce(
      projectPage([], { hasNextPage: false, endCursor: null }, {
        id: 'FIELD_STATUS',
        options: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
      }),
    )

    const snapshot = await client().fetchProjectSnapshot('PVT_1')
    expect(snapshot.columns.map((c) => c.isTerminal)).toEqual([false, true])
  })

  it('handles projects without a Status field: null statusFieldRemoteId, all items unstatused', async () => {
    fetchMock.mockResolvedValueOnce(
      projectPage(
        [{
          id: 'ITEM_1', isArchived: false, updatedAt: '2026-06-10T09:00:00Z',
          // even if the API returned a value, no Status field means no status mapping
          fieldValueByName: { optionId: 'stray' },
          content: { __typename: 'Issue', title: 'Orphan', url: null, state: 'CLOSED' },
        }],
        { hasNextPage: false, endCursor: null },
        null,
      ),
    )

    const snapshot = await client().fetchProjectSnapshot('PVT_1')
    expect(snapshot.statusFieldRemoteId).toBeNull()
    expect(snapshot.columns).toEqual([])
    expect(snapshot.items[0]).toMatchObject({ statusRemoteId: null, state: 'closed' })
  })

  it('throws GitHubNotFoundError when the node is not a ProjectV2', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ node: {} }))
    await expect(client().fetchProjectSnapshot('not-a-project')).rejects.toBeInstanceOf(GitHubNotFoundError)
  })
})

// ── moveItem ────────────────────────────────────────────────────────────────

describe('GitHubProjectsClient — moveItem', () => {
  it('sends the updateProjectV2ItemFieldValue mutation with the exact variables and returns updatedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: 'ITEM_1', updatedAt: '2026-06-11T12:34:56Z' },
        },
      }),
    )

    const result = await client().moveItem('PVT_1', 'ITEM_1', 'FIELD_STATUS', 'opt-done')

    expect(result).toEqual({ updatedAt: '2026-06-11T12:34:56Z' })

    const body = requestBody(0)
    expect(body.query).toContain('updateProjectV2ItemFieldValue')
    expect(body.query).toContain('singleSelectOptionId')
    expect(body.variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'ITEM_1',
      fieldId: 'FIELD_STATUS',
      optionId: 'opt-done',
    })
  })

  it('throws when the mutation returns no item', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ updateProjectV2ItemFieldValue: { projectV2Item: null } }))
    await expect(client().moveItem('PVT_1', 'ITEM_1', 'F', 'o')).rejects.toThrow(/returned no item/)
  })
})

// ── fetchItemVersion ────────────────────────────────────────────────────────

describe('GitHubProjectsClient — fetchItemVersion', () => {
  it('returns updatedAt for a live item and null for a null node', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ node: { updatedAt: '2026-06-11T08:00:00Z' } }))
    await expect(client().fetchItemVersion('ITEM_1')).resolves.toBe('2026-06-11T08:00:00Z')

    fetchMock.mockResolvedValueOnce(dataResponse({ node: null }))
    await expect(client().fetchItemVersion('ITEM_GONE')).resolves.toBeNull()
  })
})
