import { stableHash } from '@creare/shared'
import { BaseConnector } from './base'
import type {
  ConnectorCapabilities,
  FetchResult,
  MirrorBoardSnapshot,
  MirrorColumnSnapshot,
  MirrorItemSnapshot,
  MutationEnvelope,
  MutationKind,
  MutationOp,
  MutationResult,
  NormalizedEntity,
  RemoteBoardOption,
  RemoteRef,
  ResourceOption,
} from '../types'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// Safety cap on /v1/search pagination — 50 pages × 100 = 5 000 databases,
// far beyond any real workspace; guards against a misbehaving cursor loop.
const MAX_SEARCH_PAGES = 50

// ── statusFieldRemoteId convention (bidirectional-sync.md §3.2, Notion row) ──
// A Notion database is board-like when it has a Status (preferred) or Select
// property — the options are the columns. The mirror engine stores the
// snapshot's statusFieldRemoteId opaquely on the board link and echoes it back
// on move_item ops, so this connector encodes BOTH facts a write needs into it:
//
//     "<propType>:<propName>"   e.g. "status:Status" or "select:Stage"
//
// Notion's page-update API keys properties by NAME, and the patch shape
// differs per type ({ status: { id } } vs { select: { id } }) — encoding both
// lets applyMutation build the PATCH without an extra database read. A move op
// arriving without the prefix falls back to re-reading the database via
// ref.containerId. Column remoteIds are the option ids (what move_item's
// toStatusRemoteId carries).

export class NotionConnector extends BaseConnector {
  get source() { return 'notion' as const }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    }
  }

  // Paginated /v1/search for databases. Notion's search only surfaces content
  // explicitly shared with the integration — that IS Notion's shared/invited
  // model, so the filter stays; we just walk every page so workspaces with
  // >100 shared databases aren't truncated (mirrors fetchBoardSnapshot's
  // start_cursor loop).
  private async searchDatabases(): Promise<NotionSearchDatabase[]> {
    const databases: NotionSearchDatabase[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < MAX_SEARCH_PAGES; pages++) {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
      }
      if (cursor) body['start_cursor'] = cursor

      const res = await this.fetchWithRetry(
        `${NOTION_API}/search`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      )
      if (!res.ok) break

      const data = await res.json() as NotionDbSearchResult
      databases.push(...(data.results ?? []))
      cursor = data.has_more ? (data.next_cursor ?? null) : null
      if (cursor === null) break
    }
    return databases
  }

  // All databases shared with the integration — powers the database picker
  override async listResources(): Promise<ResourceOption[]> {
    const databases = await this.searchDatabases()
    return databases.map((db) => {
      const title = (db.title ?? []).map((t) => t.plain_text).join('')
      return {
        id: db.id,
        label: title || 'Untitled',
        metadata: { databaseId: db.id },
      }
    })
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const meta = this.config.metadata as { databaseId?: string } | undefined
    const databaseId = meta?.databaseId
    if (!databaseId) return { entities: [], nextCursor: null }

    const body: Record<string, unknown> = { page_size: 50 }
    if (cursor) body['start_cursor'] = cursor

    const res = await this.fetchWithRetry(
      `${NOTION_API}/databases/${databaseId}/query`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
    )
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`Notion database ${databaseId} query failed (HTTP ${res.status}): ${snippet}`)
    }

    const data = await res.json() as NotionQueryResult
    const entities: NormalizedEntity[] = data.results.map((page) => {
      const title = extractNotionTitle(page.properties)
      return {
        source: 'notion' as const,
        entityType: 'note',
        entityId: page.id,
        entityUrl: page.url ?? null,
        title: title || 'Untitled',
        status: extractNotionStatus(page.properties),
        assignee: null,
        updatedAt: page.last_edited_time,
        raw: { pageId: page.id },
      }
    })

    return {
      entities,
      nextCursor: data.has_more ? (data.next_cursor ?? null) : null,
    }
  }

  // ── Board-mirror surface (bidirectional-sync.md §3.2) ──────────────────────

  // Databases this token can mirror — powers the "Import remote board" picker
  override async listRemoteBoards(): Promise<RemoteBoardOption[]> {
    const databases = await this.searchDatabases()
    return databases.map((db) => {
      const title = (db.title ?? []).map((t) => t.plain_text).join('')
      const option: RemoteBoardOption = { id: db.id, label: title || 'Untitled' }
      if (db.url) option.url = db.url
      return option
    })
  }

  // Full database snapshot — columns from the Status/Select options, items
  // from the paginated page query. The pull side of the board mirror.
  override async fetchBoardSnapshot(databaseId: string): Promise<MirrorBoardSnapshot> {
    const db = await this.retrieveDatabase(databaseId)

    const statusProp = findBoardStatusProp(db.properties ?? {})
    const statusFieldRemoteId = statusProp ? `${statusProp.type}:${statusProp.name}` : null
    const options = statusProp?.options ?? []
    const completeOptionIds = new Set(statusProp?.completeOptionIds ?? [])

    const columns: MirrorColumnSnapshot[] = options.map((opt, index) => ({
      remoteId: opt.id,
      name: opt.name,
      position: index,
      // Terminal = a "done-ish" name, or membership in the status "Complete" group
      isTerminal: /done|complete|closed/i.test(opt.name) || completeOptionIds.has(opt.id),
    }))
    const terminalOptionIds = new Set(columns.filter((c) => c.isTerminal).map((c) => c.remoteId))

    const items: MirrorItemSnapshot[] = []
    let cursor: string | null = null
    do {
      const body: Record<string, unknown> = { page_size: 100 }
      if (cursor) body['start_cursor'] = cursor

      const res = await this.fetchWithRetry(
        `${NOTION_API}/databases/${databaseId}/query`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      )
      if (!res.ok) throw new Error(`Notion database ${databaseId} query failed (HTTP ${res.status})`)

      const data = await res.json() as NotionQueryResult
      for (const page of data.results) {
        const title = extractNotionTitle(page.properties) || 'Untitled'
        // Read the page's value from the SAME property the columns came from
        const value = statusProp ? page.properties[statusProp.name] : undefined
        const statusRemoteId = value?.status?.id ?? value?.select?.id ?? null
        const state: 'open' | 'closed' =
          statusRemoteId !== null && terminalOptionIds.has(statusRemoteId) ? 'closed' : 'open'
        const archived = page.archived ?? false
        items.push({
          remoteId: page.id,
          containerRemoteId: databaseId,
          title,
          url: page.url ?? null,
          statusRemoteId,
          state,
          archived,
          version: page.last_edited_time,
          contentHash: stableHash({ title, statusRemoteId, state, archived }),
        })
      }
      cursor = data.has_more ? (data.next_cursor ?? null) : null
    } while (cursor !== null)

    return {
      remoteId: databaseId,
      title: (db.title ?? []).map((t) => t.plain_text).join('') || 'Untitled',
      url: db.url ?? null,
      version: db.last_edited_time,
      statusFieldRemoteId,
      columns,
      items,
    }
  }

  // ── Write surface (bidirectional-sync.md §3.2) ─────────────────────────────

  override get capabilities(): ConnectorCapabilities {
    return {
      write: [
        'move_item', 'create_item', 'update_item',
        'comment', 'close_item', 'archive_item',
      ] as MutationKind[],
    }
  }

  override async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    const { op } = envelope
    switch (op.kind) {
      case 'move_item':
        return this.moveItem(op)
      case 'create_item':
        return this.createItem(op)
      case 'update_item':
        return this.updateItem(op)
      case 'comment':
        return this.addComment(op)
      // Notion has no open/closed page state — close maps to archive (the
      // Notion "trash"/hide semantics), reopen un-archives. reopen_item is
      // handled for symmetry even though it is not advertised yet.
      case 'close_item':
      case 'archive_item':
        return this.setArchived(op.ref, true)
      case 'reopen_item':
        return this.setArchived(op.ref, false)
    }
  }

  // Set the Status/Select value = move the card between columns
  private async moveItem(op: Extract<MutationOp, { kind: 'move_item' }>): Promise<MutationResult> {
    const prop = await this.resolveStatusProp(op.statusFieldRemoteId, op.ref.containerId)
    const value = prop.type === 'status'
      ? { status: { id: op.toStatusRemoteId } }
      : { select: { id: op.toStatusRemoteId } }
    return this.patchPage(op.ref, { properties: { [prop.name]: value } })
  }

  private async createItem(op: Extract<MutationOp, { kind: 'create_item' }>): Promise<MutationResult> {
    const databaseId = op.container.remoteId
    const titlePropName = await this.discoverTitlePropName(databaseId)
    const res = await this.fetchWithRetry(
      `${NOTION_API}/pages`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties: { [titlePropName]: { title: [{ text: { content: op.title } }] } },
        }),
      },
    )
    if (!res.ok) throw new Error(`Notion page create failed (HTTP ${res.status}) in database ${databaseId}`)

    const page = await res.json() as NotionPage
    const result = this.mutationResult({ remoteType: 'db_page', remoteId: page.id, containerId: databaseId }, page)
    // A freshly created page has only its title set — no status/select value, so
    // the pull snapshot computes statusRemoteId:null → state 'open', archived
    // false (see fetchBoardSnapshot). Stamp that as the baseline.
    result.createdBaseline = {
      remoteId: page.id,
      title: op.title,
      statusRemoteId: null,
      state: 'open',
      archived: false,
    }
    return result
  }

  private async updateItem(op: Extract<MutationOp, { kind: 'update_item' }>): Promise<MutationResult> {
    if (op.patch.title === undefined) {
      throw new Error('update_item on Notion currently only patches the title — op carried no title')
    }
    // The title column can be renamed per-database; discover it via the
    // containing database. Fallback: the title property's id is always the
    // literal "title", which the pages API also accepts as a key.
    const titlePropName = op.ref.containerId
      ? await this.discoverTitlePropName(op.ref.containerId)
      : 'title'
    return this.patchPage(op.ref, {
      properties: { [titlePropName]: { title: [{ text: { content: op.patch.title } }] } },
    })
  }

  private async addComment(op: Extract<MutationOp, { kind: 'comment' }>): Promise<MutationResult> {
    const res = await this.fetchWithRetry(
      `${NOTION_API}/comments`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          parent: { page_id: op.ref.remoteId },
          rich_text: [{ text: { content: op.body } }],
        }),
      },
    )
    if (!res.ok) throw new Error(`Notion comment failed (HTTP ${res.status}) on page ${op.ref.remoteId}`)

    const comment = await res.json() as NotionComment
    // Comments don't bump the page's last_edited_time deterministically — no
    // version claim, the next pull reconciles
    return { ref: op.ref, remoteVersion: null, raw: { commentId: comment.id } }
  }

  private async setArchived(ref: RemoteRef, archived: boolean): Promise<MutationResult> {
    return this.patchPage(ref, { archived })
  }

  // ── Notion plumbing ────────────────────────────────────────────────────────

  private async patchPage(ref: RemoteRef, body: Record<string, unknown>): Promise<MutationResult> {
    const res = await this.fetchWithRetry(
      `${NOTION_API}/pages/${ref.remoteId}`,
      { method: 'PATCH', headers: this.headers, body: JSON.stringify(body) },
    )
    if (!res.ok) throw new Error(`Notion page update failed (HTTP ${res.status}) for page ${ref.remoteId}`)
    return this.mutationResult(ref, await res.json() as NotionPage)
  }

  private mutationResult(ref: RemoteRef, page: NotionPage): MutationResult {
    const result: MutationResult = {
      ref,
      remoteVersion: page.last_edited_time ?? null,
      raw: { pageId: page.id },
    }
    if (page.url) result.remoteUrl = page.url
    return result
  }

  private async retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    const res = await this.fetchWithRetry(
      `${NOTION_API}/databases/${databaseId}`,
      { headers: this.headers },
    )
    if (!res.ok) {
      throw new Error(`Notion database ${databaseId} not found or not shared with the integration (HTTP ${res.status})`)
    }
    return await res.json() as NotionDatabase
  }

  // Decodes the "<type>:<name>" statusFieldRemoteId convention; an op that
  // arrives without it (or unprefixed) falls back to re-reading the database.
  private async resolveStatusProp(
    statusFieldRemoteId: string | undefined,
    databaseId: string | undefined,
  ): Promise<{ name: string; type: 'status' | 'select' }> {
    if (statusFieldRemoteId) {
      const match = /^(status|select):(.+)$/.exec(statusFieldRemoteId)
      if (match) return { type: match[1] as 'status' | 'select', name: match[2]! }
    }
    if (!databaseId) {
      throw new Error('move_item op needs statusFieldRemoteId ("status:<name>" / "select:<name>") or ref.containerId to discover the status property')
    }
    const db = await this.retrieveDatabase(databaseId)
    const prop = findBoardStatusProp(db.properties ?? {})
    if (!prop) throw new Error(`Notion database ${databaseId} has no status or select property to move items on`)
    return { name: prop.name, type: prop.type }
  }

  // The property of type 'title' — its name is user-renamable per database
  private async discoverTitlePropName(databaseId: string): Promise<string> {
    const db = await this.retrieveDatabase(databaseId)
    for (const [name, prop] of Object.entries(db.properties ?? {})) {
      if (prop.type === 'title') return name
    }
    return 'title' // the title property's id is always the literal "title"
  }
}

function extractNotionTitle(props: Record<string, NotionProperty>): string {
  for (const prop of Object.values(props)) {
    if (prop.type === 'title' && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join('')
    }
  }
  return ''
}

function extractNotionStatus(props: Record<string, NotionProperty>): string | null {
  for (const prop of Object.values(props)) {
    if (prop.type === 'status') return prop.status?.name ?? null
    if (prop.type === 'select') return prop.select?.name ?? null
  }
  return null
}

// The board-defining property: first 'status' property wins, first 'select'
// is the fallback. completeOptionIds = options in the status "Complete" group.
function findBoardStatusProp(props: Record<string, NotionDbProperty>): {
  name: string
  type: 'status' | 'select'
  options: NotionSelectOption[]
  completeOptionIds: string[]
} | null {
  let selectFallback: ReturnType<typeof findBoardStatusProp> = null
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'status' && prop.status) {
      const completeOptionIds = (prop.status.groups ?? [])
        .filter((g) => g.name === 'Complete')
        .flatMap((g) => g.option_ids)
      return { name, type: 'status', options: prop.status.options ?? [], completeOptionIds }
    }
    if (prop.type === 'select' && prop.select && !selectFallback) {
      selectFallback = { name, type: 'select', options: prop.select.options ?? [], completeOptionIds: [] }
    }
  }
  return selectFallback
}

interface NotionSearchDatabase {
  id: string
  url?: string
  title?: Array<{ plain_text: string }>
}

interface NotionDbSearchResult {
  results?: NotionSearchDatabase[]
  has_more?: boolean
  next_cursor?: string | null
}

interface NotionQueryResult {
  results: NotionPage[]
  has_more: boolean
  next_cursor: string | null
}

interface NotionPage {
  id: string
  url?: string
  archived?: boolean
  last_edited_time: string
  properties: Record<string, NotionProperty>
}

// Page property VALUE (databases/{id}/query, pages/{id})
interface NotionProperty {
  type: string
  title?: Array<{ plain_text: string }>
  status?: { id?: string; name: string } | null
  select?: { id?: string; name: string } | null
}

// Database property SCHEMA (databases/{id})
interface NotionDbProperty {
  id: string
  type: string
  status?: {
    options?: NotionSelectOption[]
    groups?: Array<{ id: string; name: string; option_ids: string[] }>
  }
  select?: { options?: NotionSelectOption[] }
}

interface NotionSelectOption { id: string; name: string }

interface NotionDatabase {
  id: string
  url?: string
  last_edited_time: string
  title?: Array<{ plain_text: string }>
  properties?: Record<string, NotionDbProperty>
}

interface NotionComment { id: string }
