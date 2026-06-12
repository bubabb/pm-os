import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stableHash } from '@creare/shared'
import {
  GitHubProjectsClient,
  GitHubRateLimitError,
  GitHubScopeError,
  GitHubNotFoundError,
  parseProjectUrl,
} from './github-projects'
import { GitHubConnector } from './github'
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

// ── parseProjectUrl ─────────────────────────────────────────────────────────

describe('parseProjectUrl', () => {
  it('parses a user project URL', () => {
    expect(parseProjectUrl('https://github.com/users/rsemnani/projects/2')).toEqual({
      login: 'rsemnani', number: 2, ownerType: 'user',
    })
  })

  it('parses an org project URL', () => {
    expect(parseProjectUrl('https://github.com/orgs/acme/projects/7')).toEqual({
      login: 'acme', number: 7, ownerType: 'org',
    })
  })

  it('tolerates www host, trailing segments (views), query strings, and whitespace', () => {
    expect(parseProjectUrl(' https://www.github.com/users/me/projects/3/views/1?pane=info ')).toEqual({
      login: 'me', number: 3, ownerType: 'user',
    })
  })

  it('returns null for non-URL input (bare numbers require the picker, not resolve)', () => {
    expect(parseProjectUrl('2')).toBeNull()
    expect(parseProjectUrl('not a url')).toBeNull()
    expect(parseProjectUrl('')).toBeNull()
  })

  it('returns null for non-GitHub hosts and non-project GitHub URLs', () => {
    expect(parseProjectUrl('https://gitlab.com/users/me/projects/2')).toBeNull()
    expect(parseProjectUrl('https://github.com/acme/app/projects/2')).toBeNull() // repo path, not users/orgs
    expect(parseProjectUrl('https://github.com/users/me/projects/')).toBeNull()
    expect(parseProjectUrl('https://github.com/users/me/projects/abc')).toBeNull()
    expect(parseProjectUrl('https://github.com/users/me/projects/0')).toBeNull()
  })
})

// ── resolveProject (cross-owner import) ─────────────────────────────────────

const RESOLVED_NODE = {
  id: 'PVT_other',
  title: 'Their Roadmap',
  number: 2,
  url: 'https://github.com/users/rsemnani/projects/2',
}

const RESOLVED_OPTION = {
  id: 'PVT_other',
  label: 'Their Roadmap',
  sublabel: '#2',
  url: 'https://github.com/users/rsemnani/projects/2',
}

describe('GitHubProjectsClient — resolveProject', () => {
  it('resolves a user-owned project on the first query', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ user: { projectV2: RESOLVED_NODE } }))

    await expect(client().resolveProject('rsemnani', 2)).resolves.toEqual(RESOLVED_OPTION)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = requestBody(0)
    expect(body.query).toContain('user(login: $login)')
    expect(body.query).toContain('projectV2(number: $number)')
    expect(body.variables).toEqual({ login: 'rsemnani', number: 2 })
  })

  it('falls back to organization(login) when the user query is NOT_FOUND', async () => {
    fetchMock
      .mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'no such user' }]))
      .mockResolvedValueOnce(dataResponse({ organization: { projectV2: RESOLVED_NODE } }))

    await expect(client().resolveProject('rsemnani', 2)).resolves.toEqual(RESOLVED_OPTION)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(1).query).toContain('organization(login: $login)')
    expect(requestBody(1).variables).toEqual({ login: 'rsemnani', number: 2 })
  })

  it('falls back to organization(login) when the user exists but has no such project', async () => {
    fetchMock
      .mockResolvedValueOnce(dataResponse({ user: { projectV2: null } }))
      .mockResolvedValueOnce(dataResponse({ organization: { projectV2: RESOLVED_NODE } }))

    await expect(client().resolveProject('rsemnani', 2)).resolves.toEqual(RESOLVED_OPTION)
  })

  it('returns null (never throws) when neither user nor organization resolves', async () => {
    fetchMock
      .mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'no such user' }]))
      .mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'no such org' }]))

    await expect(client().resolveProject('nobody', 99)).resolves.toBeNull()
  })

  it('lets scope/auth errors propagate instead of mapping them to null', async () => {
    fetchMock.mockResolvedValueOnce(
      errorsResponse([{ type: 'INSUFFICIENT_SCOPES', message: 'token needs project scope' }]),
    )
    await expect(client().resolveProject('rsemnani', 2)).rejects.toBeInstanceOf(GitHubScopeError)
  })
})

describe('GitHubConnector — resolveRemoteBoard', () => {
  it('parses the project URL and resolves it through the client', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ user: { projectV2: RESOLVED_NODE } }))

    await expect(
      connector().resolveRemoteBoard('https://github.com/users/rsemnani/projects/2'),
    ).resolves.toEqual(RESOLVED_OPTION)

    expect(requestBody(0).variables).toEqual({ login: 'rsemnani', number: 2 })
  })

  it('returns null without any network call when the ref does not parse', async () => {
    await expect(connector().resolveRemoteBoard('2')).resolves.toBeNull()
    await expect(connector().resolveRemoteBoard('https://github.com/acme/app')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
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

// ── Phase 2 write mutations (item lifecycle) ────────────────────────────────

describe('GitHubProjectsClient — addDraftIssue', () => {
  it('sends addProjectV2DraftIssue with projectId/title/body and returns the new item id + updatedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        addProjectV2DraftIssue: { projectItem: { id: 'ITEM_NEW', updatedAt: '2026-06-11T13:00:00Z' } },
      }),
    )

    const result = await client().addDraftIssue('PVT_1', 'New card', 'Card body')

    expect(result).toEqual({ itemId: 'ITEM_NEW', updatedAt: '2026-06-11T13:00:00Z' })
    const body = requestBody(0)
    expect(body.query).toContain('addProjectV2DraftIssue')
    expect(body.variables).toEqual({ projectId: 'PVT_1', title: 'New card', body: 'Card body' })
  })

  it('omits the body variable entirely when no body is given', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        addProjectV2DraftIssue: { projectItem: { id: 'ITEM_NEW', updatedAt: '2026-06-11T13:00:00Z' } },
      }),
    )

    await client().addDraftIssue('PVT_1', 'Title only')

    // undefined is dropped by JSON.stringify → GraphQL sees "not provided"
    expect(requestBody(0).variables).toEqual({ projectId: 'PVT_1', title: 'Title only' })
  })

  it('throws when the mutation returns no item', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ addProjectV2DraftIssue: { projectItem: null } }))
    await expect(client().addDraftIssue('PVT_1', 'x')).rejects.toThrow(/returned no item/)
  })
})

describe('GitHubProjectsClient — updateDraftIssue', () => {
  it('sends updateProjectV2DraftIssue with only the provided patch fields and returns updatedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        updateProjectV2DraftIssue: { draftIssue: { id: 'DI_1', updatedAt: '2026-06-11T14:00:00Z' } },
      }),
    )

    const result = await client().updateDraftIssue('DI_1', { title: 'Renamed' })

    expect(result).toEqual({ updatedAt: '2026-06-11T14:00:00Z' })
    const body = requestBody(0)
    expect(body.query).toContain('updateProjectV2DraftIssue')
    // body was not in the patch → variable absent, remote body untouched
    expect(body.variables).toEqual({ draftIssueId: 'DI_1', title: 'Renamed' })
  })

  it('throws when the mutation returns no draft issue', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ updateProjectV2DraftIssue: { draftIssue: null } }))
    await expect(client().updateDraftIssue('DI_1', { body: 'x' })).rejects.toThrow(/returned no draft issue/)
  })
})

describe('GitHubProjectsClient — archiveItem / unarchiveItem', () => {
  it('archiveItem sends archiveProjectV2Item with projectId/itemId and returns updatedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ archiveProjectV2Item: { item: { id: 'ITEM_1', updatedAt: '2026-06-11T15:00:00Z' } } }),
    )

    const result = await client().archiveItem('PVT_1', 'ITEM_1')

    expect(result).toEqual({ updatedAt: '2026-06-11T15:00:00Z' })
    const body = requestBody(0)
    expect(body.query).toContain('archiveProjectV2Item')
    expect(body.variables).toEqual({ projectId: 'PVT_1', itemId: 'ITEM_1' })
  })

  it('unarchiveItem sends unarchiveProjectV2Item with projectId/itemId and returns updatedAt', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ unarchiveProjectV2Item: { item: { id: 'ITEM_1', updatedAt: '2026-06-11T16:00:00Z' } } }),
    )

    const result = await client().unarchiveItem('PVT_1', 'ITEM_1')

    expect(result).toEqual({ updatedAt: '2026-06-11T16:00:00Z' })
    const body = requestBody(0)
    expect(body.query).toContain('unarchiveProjectV2Item')
    expect(body.variables).toEqual({ projectId: 'PVT_1', itemId: 'ITEM_1' })
  })

  it('throws when archive/unarchive return no item', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ archiveProjectV2Item: { item: null } }))
    await expect(client().archiveItem('PVT_1', 'ITEM_1')).rejects.toThrow(/returned no item/)

    fetchMock.mockResolvedValueOnce(dataResponse({ unarchiveProjectV2Item: { item: null } }))
    await expect(client().unarchiveItem('PVT_1', 'ITEM_1')).rejects.toThrow(/returned no item/)
  })
})

describe('GitHubProjectsClient — fetchItemContent', () => {
  it('resolves a draft-backed item to its DraftIssue content id', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ node: { content: { __typename: 'DraftIssue', id: 'DI_1' } } }),
    )
    await expect(client().fetchItemContent('ITEM_1')).resolves.toEqual({
      type: 'DraftIssue',
      contentId: 'DI_1',
    })
  })

  it('resolves an issue-backed item to owner/repo/number REST coordinates', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        node: {
          content: { __typename: 'Issue', id: 'I_1', number: 42, repository: { nameWithOwner: 'acme/app' } },
        },
      }),
    )
    await expect(client().fetchItemContent('ITEM_1')).resolves.toEqual({
      type: 'Issue',
      contentId: 'I_1',
      number: 42,
      owner: 'acme',
      repo: 'app',
    })
  })

  it('returns null for a vanished item, an invisible content, and NOT_FOUND', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ node: null }))
    await expect(client().fetchItemContent('ITEM_GONE')).resolves.toBeNull()

    fetchMock.mockResolvedValueOnce(dataResponse({ node: { content: null } }))
    await expect(client().fetchItemContent('ITEM_HIDDEN')).resolves.toBeNull()

    fetchMock.mockResolvedValueOnce(errorsResponse([{ type: 'NOT_FOUND', message: 'gone' }]))
    await expect(client().fetchItemContent('ITEM_404')).resolves.toBeNull()
  })
})

// ── GitHubConnector.applyMutation dispatch ──────────────────────────────────
// The connector composes the client; same mocked fetch, no network.

const connector = () =>
  new GitHubConnector({ credentialId: 'cred-1', projectId: 'proj-1', token: 'test-token' })

function envelopeFor(op: MutationOp): MutationEnvelope {
  return { opId: 'op-1', credentialId: 'cred-1', projectId: 'proj-1', source: 'github', baseVersion: null, op }
}

const PV2_REF = { remoteType: 'pv2_item', remoteId: 'ITEM_1', containerId: 'PVT_1' }

function draftContentResponse(): Response {
  return dataResponse({ node: { content: { __typename: 'DraftIssue', id: 'DI_1' } } })
}

function issueContentResponse(): Response {
  return dataResponse({
    node: {
      content: { __typename: 'Issue', id: 'I_1', number: 42, repository: { nameWithOwner: 'acme/app' } },
    },
  })
}

describe('GitHubConnector — capabilities', () => {
  it('advertises the full Phase 2 item-lifecycle write surface', () => {
    expect(connector().capabilities.write.sort()).toEqual(
      ['close_item', 'comment', 'create_item', 'move_item', 'reopen_item', 'update_item'],
    )
  })
})

describe('GitHubConnector — applyMutation dispatch', () => {
  it('move_item sets the Status single-select (Phase 1 behavior unchanged)', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_1', updatedAt: '2026-06-11T12:00:00Z' } },
      }),
    )

    const result = await connector().applyMutation(envelopeFor({
      kind: 'move_item', ref: PV2_REF, toStatusRemoteId: 'opt-done', statusFieldRemoteId: 'FIELD_STATUS',
    }))

    expect(result).toEqual({ ref: PV2_REF, remoteVersion: '2026-06-11T12:00:00Z', raw: { updatedAt: '2026-06-11T12:00:00Z' } })
    expect(requestBody(0).query).toContain('updateProjectV2ItemFieldValue')
  })

  it('create_item adds a draft and returns a ref to the NEW pv2 item', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({
        addProjectV2DraftIssue: { projectItem: { id: 'ITEM_NEW', updatedAt: '2026-06-11T13:00:00Z' } },
      }),
    )

    const result = await connector().applyMutation(envelopeFor({
      kind: 'create_item',
      container: { remoteType: 'pv2_project', remoteId: 'PVT_1' },
      title: 'New card',
      body: 'Card body',
    }))

    expect(result).toEqual({
      ref: { remoteType: 'pv2_item', remoteId: 'ITEM_NEW', containerId: 'PVT_1' },
      remoteVersion: '2026-06-11T13:00:00Z',
      raw: { updatedAt: '2026-06-11T13:00:00Z', draft: true },
    })
    expect(requestBody(0).query).toContain('addProjectV2DraftIssue')
    expect(requestBody(0).variables).toEqual({ projectId: 'PVT_1', title: 'New card', body: 'Card body' })
  })

  it('update_item on a draft resolves the content id then updates the draft', async () => {
    fetchMock
      .mockResolvedValueOnce(draftContentResponse())
      .mockResolvedValueOnce(
        dataResponse({
          updateProjectV2DraftIssue: { draftIssue: { id: 'DI_1', updatedAt: '2026-06-11T14:00:00Z' } },
        }),
      )

    const result = await connector().applyMutation(envelopeFor({
      kind: 'update_item', ref: PV2_REF, patch: { title: 'Renamed', body: 'New body' },
    }))

    expect(result).toEqual({ ref: PV2_REF, remoteVersion: '2026-06-11T14:00:00Z', raw: { updatedAt: '2026-06-11T14:00:00Z' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(0).query).toContain('ItemContent')
    expect(requestBody(1).query).toContain('updateProjectV2DraftIssue')
    expect(requestBody(1).variables).toEqual({ draftIssueId: 'DI_1', title: 'Renamed', body: 'New body' })
  })

  it('update_item on an issue-backed item throws UnsupportedMutationError (REST PATCH is a later phase)', async () => {
    fetchMock.mockResolvedValueOnce(issueContentResponse())
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'update_item', ref: PV2_REF, patch: { title: 'Renamed' } })),
    ).rejects.toBeInstanceOf(UnsupportedMutationError)
  })

  it('update_item with no title/body in the patch fails fast without any network call', async () => {
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'update_item', ref: PV2_REF, patch: { labels: ['bug'] } })),
    ).rejects.toThrow(/no supported fields/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('close_item archives the board item via archiveProjectV2Item', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ archiveProjectV2Item: { item: { id: 'ITEM_1', updatedAt: '2026-06-11T15:00:00Z' } } }),
    )

    const result = await connector().applyMutation(envelopeFor({ kind: 'close_item', ref: PV2_REF }))

    expect(result).toEqual({
      ref: PV2_REF,
      remoteVersion: '2026-06-11T15:00:00Z',
      raw: { updatedAt: '2026-06-11T15:00:00Z', archived: true },
    })
    expect(requestBody(0).query).toContain('archiveProjectV2Item')
    expect(requestBody(0).variables).toEqual({ projectId: 'PVT_1', itemId: 'ITEM_1' })
  })

  it('reopen_item unarchives the board item via unarchiveProjectV2Item', async () => {
    fetchMock.mockResolvedValueOnce(
      dataResponse({ unarchiveProjectV2Item: { item: { id: 'ITEM_1', updatedAt: '2026-06-11T16:00:00Z' } } }),
    )

    const result = await connector().applyMutation(envelopeFor({ kind: 'reopen_item', ref: PV2_REF }))

    expect(result).toEqual({
      ref: PV2_REF,
      remoteVersion: '2026-06-11T16:00:00Z',
      raw: { updatedAt: '2026-06-11T16:00:00Z', archived: false },
    })
    expect(requestBody(0).query).toContain('unarchiveProjectV2Item')
    expect(requestBody(0).variables).toEqual({ projectId: 'PVT_1', itemId: 'ITEM_1' })
  })

  it('close_item / reopen_item without a containerId fail before any network call', async () => {
    const bareRef = { remoteType: 'pv2_item', remoteId: 'ITEM_1' }
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'close_item', ref: bareRef })),
    ).rejects.toThrow(/missing containerId/)
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'reopen_item', ref: bareRef })),
    ).rejects.toThrow(/missing containerId/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('comment on an issue-backed item resolves coordinates then POSTs the REST comment', async () => {
    fetchMock
      .mockResolvedValueOnce(issueContentResponse())
      .mockResolvedValueOnce(jsonResponse(
        {
          id: 9001,
          html_url: 'https://github.com/acme/app/issues/42#issuecomment-9001',
          created_at: '2026-06-11T17:00:00Z',
        },
        201,
      ))

    const result = await connector().applyMutation(envelopeFor({
      kind: 'comment', ref: PV2_REF, body: 'Looks good to me',
    }))

    expect(result).toEqual({
      ref: PV2_REF,
      remoteVersion: '2026-06-11T17:00:00Z',
      remoteUrl: 'https://github.com/acme/app/issues/42#issuecomment-9001',
      raw: { commentId: 9001, createdAt: '2026-06-11T17:00:00Z' },
    })

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/acme/app/issues/42/comments')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ body: 'Looks good to me' })
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token')
  })

  it('comment on a draft-backed item throws UnsupportedMutationError (no comment target)', async () => {
    fetchMock.mockResolvedValueOnce(draftContentResponse())
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'comment', ref: PV2_REF, body: 'hi' })),
    ).rejects.toBeInstanceOf(UnsupportedMutationError)
    // Only the content-resolution query went out — no REST call
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('comment / update_item on a vanished item throw GitHubNotFoundError', async () => {
    fetchMock.mockResolvedValueOnce(dataResponse({ node: null }))
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'comment', ref: PV2_REF, body: 'hi' })),
    ).rejects.toBeInstanceOf(GitHubNotFoundError)

    fetchMock.mockResolvedValueOnce(dataResponse({ node: null }))
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'update_item', ref: PV2_REF, patch: { title: 'x' } })),
    ).rejects.toBeInstanceOf(GitHubNotFoundError)
  })

  it('comment surfaces a clear error when the REST call fails', async () => {
    fetchMock
      .mockResolvedValueOnce(issueContentResponse())
      .mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404))

    await expect(
      connector().applyMutation(envelopeFor({ kind: 'comment', ref: PV2_REF, body: 'hi' })),
    ).rejects.toThrow(/acme\/app#42 failed: HTTP 404/)
  })

  it('archive_item (not in capabilities.write) throws UnsupportedMutationError', async () => {
    await expect(
      connector().applyMutation(envelopeFor({ kind: 'archive_item', ref: PV2_REF })),
    ).rejects.toBeInstanceOf(UnsupportedMutationError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
