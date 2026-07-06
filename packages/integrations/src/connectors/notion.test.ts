import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stableHash } from '@creare/shared'
import { NotionConnector } from './notion'
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

function requestBody(callIndex: number): Record<string, unknown> {
  return JSON.parse(requestAt(callIndex).init.body as string) as Record<string, unknown>
}

const config: ConnectorConfig = {
  credentialId: 'cred-1',
  projectId: 'proj-1',
  token: 'secret_test',
}

const connector = () => new NotionConnector(config)

function envelope(op: MutationOp): MutationEnvelope {
  return {
    opId: 'op-1',
    credentialId: 'cred-1',
    projectId: 'proj-1',
    source: 'notion',
    baseVersion: null,
    op,
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DB_ID = 'db-123'

// Status property named "Stage" (renamed by the user — names are not stable),
// title property renamed to "Task name".
const DATABASE = {
  id: DB_ID,
  url: 'https://notion.so/db-123',
  last_edited_time: '2026-06-11T10:00:00.000Z',
  title: [{ plain_text: 'Sprint ' }, { plain_text: 'Board' }],
  properties: {
    'Task name': { id: 'title', type: 'title', title: {} },
    Stage: {
      id: 'prop-stage',
      type: 'status',
      status: {
        options: [
          { id: 'opt-todo', name: 'Not started' },
          { id: 'opt-prog', name: 'In progress' },
          { id: 'opt-ship', name: 'Shipped' }, // terminal only via the Complete group
        ],
        groups: [
          { id: 'grp-todo', name: 'To-do', option_ids: ['opt-todo'] },
          { id: 'grp-prog', name: 'In progress', option_ids: ['opt-prog'] },
          { id: 'grp-done', name: 'Complete', option_ids: ['opt-ship'] },
        ],
      },
    },
  },
}

function page(id: string, title: string, statusOptionId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://notion.so/${id}`,
    archived: false,
    last_edited_time: '2026-06-10T09:00:00.000Z',
    properties: {
      'Task name': { type: 'title', title: [{ plain_text: title }] },
      Stage: { type: 'status', status: statusOptionId ? { id: statusOptionId, name: 'x' } : null },
    },
    ...overrides,
  }
}

// ── listRemoteBoards ─────────────────────────────────────────────────────────

describe('NotionConnector — listRemoteBoards', () => {
  it('searches for databases and maps them to RemoteBoardOption with an Untitled fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { id: 'db-1', url: 'https://notion.so/db-1', title: [{ plain_text: 'Roadmap' }] },
        { id: 'db-2', title: [] }, // no title, no url
      ],
    }))

    const boards = await connector().listRemoteBoards()

    expect(boards).toEqual([
      { id: 'db-1', label: 'Roadmap', url: 'https://notion.so/db-1' },
      { id: 'db-2', label: 'Untitled' },
    ])

    const { url, init } = requestAt(0)
    expect(url).toBe('https://api.notion.com/v1/search')
    expect(init.method).toBe('POST')
    expect(requestBody(0)['filter']).toEqual({ property: 'object', value: 'database' })

    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret_test')
    expect(headers['Notion-Version']).toBe('2022-06-28')
  })

  it('paginates the search with start_cursor while has_more and concatenates all pages', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 'db-1', title: [{ plain_text: 'Page one DB' }] }],
        has_more: true,
        next_cursor: 'search-cursor-1',
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 'db-2', title: [{ plain_text: 'Page two DB' }] }],
        has_more: false,
        next_cursor: null,
      }))

    const boards = await connector().listRemoteBoards()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestAt(0).url).toBe('https://api.notion.com/v1/search')
    expect(requestAt(1).url).toBe('https://api.notion.com/v1/search')
    // First page carries no cursor; the second carries the returned one —
    // and the database filter rides along on every page
    expect(requestBody(0)).toEqual({
      filter: { property: 'object', value: 'database' },
      page_size: 100,
    })
    expect(requestBody(1)).toEqual({
      filter: { property: 'object', value: 'database' },
      page_size: 100,
      start_cursor: 'search-cursor-1',
    })

    expect(boards).toEqual([
      { id: 'db-1', label: 'Page one DB' },
      { id: 'db-2', label: 'Page two DB' },
    ])
  })

  it('returns [] on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 404))
    await expect(connector().listRemoteBoards()).resolves.toEqual([])
  })
})

// ── listResources ────────────────────────────────────────────────────────────

describe('NotionConnector — listResources', () => {
  it('maps databases to ResourceOption with databaseId metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { id: 'db-1', title: [{ plain_text: 'Roadmap' }] },
        { id: 'db-2', title: [] },
      ],
      has_more: false,
      next_cursor: null,
    }))

    await expect(connector().listResources()).resolves.toEqual([
      { id: 'db-1', label: 'Roadmap', metadata: { databaseId: 'db-1' } },
      { id: 'db-2', label: 'Untitled', metadata: { databaseId: 'db-2' } },
    ])
    expect(requestBody(0)['filter']).toEqual({ property: 'object', value: 'database' })
  })

  it('follows has_more across search pages so >100 shared databases are not truncated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 'db-1', title: [{ plain_text: 'First' }] }],
        has_more: true,
        next_cursor: 'search-cursor-1',
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 'db-2', title: [{ plain_text: 'Second' }] }],
        has_more: false,
        next_cursor: null,
      }))

    const resources = await connector().listResources()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(1)['start_cursor']).toBe('search-cursor-1')
    expect(resources.map((r) => r.id)).toEqual(['db-1', 'db-2'])
  })

  it('keeps the databases already fetched when a later search page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        results: [{ id: 'db-1', title: [{ plain_text: 'Survivor' }] }],
        has_more: true,
        next_cursor: 'search-cursor-1',
      }))
      .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 404))

    const resources = await connector().listResources()
    expect(resources).toEqual([
      { id: 'db-1', label: 'Survivor', metadata: { databaseId: 'db-1' } },
    ])
  })
})

// ── fetchBoardSnapshot ───────────────────────────────────────────────────────

describe('NotionConnector — fetchBoardSnapshot', () => {
  it('maps status options to columns, paginated pages to items, and hashes item content', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE)) // GET /databases/{id}
      .mockResolvedValueOnce(jsonResponse({          // query page 1
        results: [
          page('page-1', 'Fix login', 'opt-todo'),
          page('page-2', 'Ship API', 'opt-ship', { archived: true }),
        ],
        has_more: true,
        next_cursor: 'cursor-1',
      }))
      .mockResolvedValueOnce(jsonResponse({          // query page 2
        results: [page('page-3', 'Unstatused note', null)],
        has_more: false,
        next_cursor: null,
      }))

    const snapshot = await connector().fetchBoardSnapshot(DB_ID)

    // Database retrieve + two query pages, the second carrying the cursor
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(requestAt(0).url).toBe(`https://api.notion.com/v1/databases/${DB_ID}`)
    expect(requestAt(1).url).toBe(`https://api.notion.com/v1/databases/${DB_ID}/query`)
    expect(requestBody(1)).toEqual({ page_size: 100 })
    expect(requestBody(2)).toEqual({ page_size: 100, start_cursor: 'cursor-1' })

    expect(snapshot.remoteId).toBe(DB_ID)
    expect(snapshot.title).toBe('Sprint Board')
    expect(snapshot.url).toBe('https://notion.so/db-123')
    expect(snapshot.version).toBe('2026-06-11T10:00:00.000Z')
    // The "<type>:<name>" convention — writes need both the patch shape and the key
    expect(snapshot.statusFieldRemoteId).toBe('status:Stage')

    // Columns: option order = position; "Shipped" is terminal via the Complete group
    expect(snapshot.columns).toEqual([
      { remoteId: 'opt-todo', name: 'Not started', position: 0, isTerminal: false },
      { remoteId: 'opt-prog', name: 'In progress', position: 1, isTerminal: false },
      { remoteId: 'opt-ship', name: 'Shipped', position: 2, isTerminal: true },
    ])

    expect(snapshot.items.map((i) => i.remoteId)).toEqual(['page-1', 'page-2', 'page-3'])

    const [open, shipped, unstatused] = snapshot.items
    expect(open).toMatchObject({
      containerRemoteId: DB_ID,
      title: 'Fix login',
      url: 'https://notion.so/page-1',
      statusRemoteId: 'opt-todo',
      state: 'open',
      archived: false,
      version: '2026-06-10T09:00:00.000Z',
    })
    expect(open!.contentHash).toBe(
      stableHash({ title: 'Fix login', statusRemoteId: 'opt-todo', state: 'open', archived: false }),
    )
    // Terminal option → closed; archived flag carried through
    expect(shipped).toMatchObject({ statusRemoteId: 'opt-ship', state: 'closed', archived: true })
    expect(unstatused).toMatchObject({ statusRemoteId: null, state: 'open' })
  })

  it('falls back to a select property (name-matched terminal) when there is no status property', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: DB_ID,
        last_edited_time: '2026-06-11T10:00:00.000Z',
        title: [{ plain_text: 'Tasks' }],
        properties: {
          Name: { id: 'title', type: 'title', title: {} },
          Phase: {
            id: 'prop-phase',
            type: 'select',
            select: { options: [{ id: 'sel-a', name: 'Active' }, { id: 'sel-b', name: 'Done' }] },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          id: 'page-1',
          last_edited_time: '2026-06-10T09:00:00.000Z',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Task A' }] },
            Phase: { type: 'select', select: { id: 'sel-b', name: 'Done' } },
          },
        }],
        has_more: false,
        next_cursor: null,
      }))

    const snapshot = await connector().fetchBoardSnapshot(DB_ID)

    expect(snapshot.statusFieldRemoteId).toBe('select:Phase')
    expect(snapshot.columns).toEqual([
      { remoteId: 'sel-a', name: 'Active', position: 0, isTerminal: false },
      { remoteId: 'sel-b', name: 'Done', position: 1, isTerminal: true },
    ])
    expect(snapshot.items[0]).toMatchObject({ statusRemoteId: 'sel-b', state: 'closed', url: null })
  })

  it('handles a database with no status/select property: no columns, unstatused items', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: DB_ID,
        last_edited_time: '2026-06-11T10:00:00.000Z',
        title: [],
        properties: { Name: { id: 'title', type: 'title', title: {} } },
      }))
      .mockResolvedValueOnce(jsonResponse({ results: [], has_more: false, next_cursor: null }))

    const snapshot = await connector().fetchBoardSnapshot(DB_ID)
    expect(snapshot.statusFieldRemoteId).toBeNull()
    expect(snapshot.columns).toEqual([])
    expect(snapshot.title).toBe('Untitled')
  })

  it('throws when the database is not visible to the integration', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
    await expect(connector().fetchBoardSnapshot(DB_ID)).rejects.toThrow(/not found or not shared/)
  })
})

// ── fetchItemSnapshot (create-finalize re-fetch) ─────────────────────────────
// Retrieves the database (status property + terminal groups) then the single
// page, normalizing via the SHARED helper so the contentHash is identical to
// what fetchBoardSnapshot computes for the same page.

describe('NotionConnector — fetchItemSnapshot', () => {
  it('returns the page snapshot whose contentHash matches the board snapshot formula', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE))                 // GET /databases/{id}
      .mockResolvedValueOnce(jsonResponse(page('page-1', 'Fix login', 'opt-todo'))) // GET /pages/{id}

    const snap = await connector().fetchItemSnapshot({ remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID })

    expect(snap).toEqual({
      remoteId: 'page-1',
      containerRemoteId: DB_ID,
      title: 'Fix login',
      url: 'https://notion.so/page-1',
      statusRemoteId: 'opt-todo',
      state: 'open',
      archived: false,
      version: '2026-06-10T09:00:00.000Z',
      contentHash: stableHash({ title: 'Fix login', statusRemoteId: 'opt-todo', state: 'open', archived: false }),
    })
    expect(requestAt(0).url).toBe(`https://api.notion.com/v1/databases/${DB_ID}`)
    expect(requestAt(1).url).toBe(`https://api.notion.com/v1/pages/page-1`)
  })

  it('reflects a terminal (Complete-group) status as closed — same as the board snapshot', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE))
      .mockResolvedValueOnce(jsonResponse(page('page-2', 'Shipped work', 'opt-ship')))

    const snap = await connector().fetchItemSnapshot({ remoteType: 'db_page', remoteId: 'page-2', containerId: DB_ID })
    expect(snap).toMatchObject({ statusRemoteId: 'opt-ship', state: 'closed' })
  })

  it('returns null when no database context is known (no containerId)', async () => {
    await expect(
      connector().fetchItemSnapshot({ remoteType: 'db_page', remoteId: 'page-1' }),
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when the page is gone (404)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE))
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
    await expect(
      connector().fetchItemSnapshot({ remoteType: 'db_page', remoteId: 'page-404', containerId: DB_ID }),
    ).resolves.toBeNull()
  })
})

// ── capabilities ─────────────────────────────────────────────────────────────

describe('NotionConnector — capabilities', () => {
  it('advertises the Notion write set', () => {
    expect(connector().capabilities).toEqual({
      write: ['move_item', 'create_item', 'update_item', 'comment', 'close_item', 'archive_item'],
    })
  })
})

// ── applyMutation ────────────────────────────────────────────────────────────

describe('NotionConnector — applyMutation move_item', () => {
  it('patches the status property by name, decoding the "status:<name>" convention', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page('page-1', 'Fix login', 'opt-ship')))

    const result = await connector().applyMutation(envelope({
      kind: 'move_item',
      ref: { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID },
      toStatusRemoteId: 'opt-ship',
      statusFieldRemoteId: 'status:Stage',
    }))

    // One PATCH, no database read needed — the convention carries type + name
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = requestAt(0)
    expect(url).toBe('https://api.notion.com/v1/pages/page-1')
    expect(init.method).toBe('PATCH')
    expect(requestBody(0)).toEqual({
      properties: { Stage: { status: { id: 'opt-ship' } } },
    })
    expect(result.remoteVersion).toBe('2026-06-10T09:00:00.000Z')
    expect(result.ref.remoteId).toBe('page-1')
  })

  it('patches a select property with the select shape for the "select:<name>" convention', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(page('page-1', 'Task A', null)))

    await connector().applyMutation(envelope({
      kind: 'move_item',
      ref: { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID },
      toStatusRemoteId: 'sel-b',
      statusFieldRemoteId: 'select:Phase',
    }))

    expect(requestBody(0)).toEqual({
      properties: { Phase: { select: { id: 'sel-b' } } },
    })
  })

  it('rediscovers the status property from the database when the op carries no statusFieldRemoteId', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE)) // GET /databases/{id} fallback
      .mockResolvedValueOnce(jsonResponse(page('page-1', 'Fix login', 'opt-prog')))

    await connector().applyMutation(envelope({
      kind: 'move_item',
      ref: { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID },
      toStatusRemoteId: 'opt-prog',
    }))

    expect(requestAt(0).url).toBe(`https://api.notion.com/v1/databases/${DB_ID}`)
    expect(requestBody(1)).toEqual({
      properties: { Stage: { status: { id: 'opt-prog' } } },
    })
  })
})

describe('NotionConnector — applyMutation create_item', () => {
  it('discovers the title property name and creates a page in the database', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE)) // title-prop discovery
      .mockResolvedValueOnce(jsonResponse({
        id: 'page-new',
        url: 'https://notion.so/page-new',
        last_edited_time: '2026-06-11T12:00:00.000Z',
        properties: {},
      }))

    const result = await connector().applyMutation(envelope({
      kind: 'create_item',
      container: { remoteType: 'database', remoteId: DB_ID },
      title: 'New task',
    }))

    const { url, init } = requestAt(1)
    expect(url).toBe('https://api.notion.com/v1/pages')
    expect(init.method).toBe('POST')
    expect(requestBody(1)).toEqual({
      parent: { database_id: DB_ID },
      properties: { 'Task name': { title: [{ text: { content: 'New task' } }] } },
    })

    expect(result.ref).toEqual({ remoteType: 'db_page', remoteId: 'page-new', containerId: DB_ID })
    expect(result.remoteVersion).toBe('2026-06-11T12:00:00.000Z')
    expect(result.remoteUrl).toBe('https://notion.so/page-new')
  })
})

describe('NotionConnector — applyMutation update_item', () => {
  it('patches the discovered title property', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DATABASE))
      .mockResolvedValueOnce(jsonResponse(page('page-1', 'Renamed', 'opt-todo')))

    await connector().applyMutation(envelope({
      kind: 'update_item',
      ref: { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID },
      patch: { title: 'Renamed' },
    }))

    expect(requestAt(1).init.method).toBe('PATCH')
    expect(requestBody(1)).toEqual({
      properties: { 'Task name': { title: [{ text: { content: 'Renamed' } }] } },
    })
  })
})

describe('NotionConnector — applyMutation close/archive/reopen', () => {
  it('archives the page for close_item and archive_item, un-archives for reopen_item', async () => {
    // Fresh Response per call — a Response body is single-read
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(page('page-1', 'Fix login', 'opt-todo'))))
    const ref = { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID }

    await connector().applyMutation(envelope({ kind: 'close_item', ref }))
    await connector().applyMutation(envelope({ kind: 'archive_item', ref }))
    await connector().applyMutation(envelope({ kind: 'reopen_item', ref }))

    expect(requestAt(0).url).toBe('https://api.notion.com/v1/pages/page-1')
    expect(requestAt(0).init.method).toBe('PATCH')
    expect(requestBody(0)).toEqual({ archived: true })
    expect(requestBody(1)).toEqual({ archived: true })
    expect(requestBody(2)).toEqual({ archived: false })
  })
})

describe('NotionConnector — applyMutation comment', () => {
  it('posts a rich_text comment parented to the page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'comment-1' }))

    const result = await connector().applyMutation(envelope({
      kind: 'comment',
      ref: { remoteType: 'db_page', remoteId: 'page-1', containerId: DB_ID },
      body: 'Looks good',
    }))

    const { url, init } = requestAt(0)
    expect(url).toBe('https://api.notion.com/v1/comments')
    expect(init.method).toBe('POST')
    expect(requestBody(0)).toEqual({
      parent: { page_id: 'page-1' },
      rich_text: [{ text: { content: 'Looks good' } }],
    })

    // Comments make no version claim — the next pull reconciles
    expect(result.remoteVersion).toBeNull()
    expect(result.raw).toEqual({ commentId: 'comment-1' })
  })
})
