import { BaseConnector, UnsupportedMutationError } from './base'
import type {
  ConnectorCapabilities,
  FetchResult,
  MutationEnvelope,
  MutationKind,
  MutationResult,
  NormalizedEntity,
  RemoteRef,
  ResourceOption,
} from '../types'

export class ConfluenceConnector extends BaseConnector {
  get source() { return 'confluence' as const }

  private get headers() {
    const meta = this.config.metadata as { email?: string } | undefined
    const email = meta?.email ?? ''
    const encoded = Buffer.from(`${email}:${this.config.token}`).toString('base64')
    return { Authorization: `Basic ${encoded}`, Accept: 'application/json' }
  }

  private get jsonHeaders() {
    return { ...this.headers, 'Content-Type': 'application/json' }
  }

  // All Confluence spaces the token can access — powers the space picker.
  // Uses the numeric space ID (what the v2 pages API filters on), not the key.
  // Follows `_links.next` (a relative URL) so sites with more spaces than one
  // page's `limit` still list everything.
  override async listResources(): Promise<ResourceOption[]> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return []

    const spaces: ResourceOption[] = []
    let url: string | null = `${baseUrl}/wiki/api/v2/spaces?limit=250`
    while (url) {
      const res = await this.fetchWithRetry(url, { headers: this.headers })
      if (!res.ok) break

      const data = await res.json() as ConfluenceSpaceList
      for (const space of data.results ?? []) {
        spaces.push({
          id: String(space.id),
          label: space.name,
          sublabel: space.key,
          metadata: { spaceId: String(space.id) },
        })
      }
      url = data._links?.next ? `${baseUrl}${data._links.next}` : null
    }
    return spaces
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return { entities: [], nextCursor: null }

    // Per-project resource scope: when a spaceId is set (source bound to a
    // global connection), filter pages to that space so other spaces on the
    // same account never leak in. This is the numeric space ID passed to the
    // v2 API's `space-id` param, not the space key.
    const meta = this.config.metadata as { spaceId?: string } | undefined
    const spaceId = meta?.spaceId
    const params = new URLSearchParams({
      'sort': '-modified-date',
      'limit': '25',
      ...(spaceId ? { 'space-id': spaceId } : {}),
      ...(cursor ? { cursor } : {}),
    })

    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/api/v2/pages?${params.toString()}`,
      { headers: this.headers },
    )
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`Confluence pages fetch failed (HTTP ${res.status}): ${snippet}`)
    }

    const data = await res.json() as ConfluencePageList
    const entities: NormalizedEntity[] = data.results.map((page) => ({
      source: 'confluence' as const,
      entityType: 'page',
      entityId: page.id,
      entityUrl: page._links?.webui ? `${baseUrl}${page._links.webui}` : null,
      title: page.title,
      status: page.status ?? null,
      assignee: null,
      updatedAt: page.version?.createdAt ?? null,
      raw: {
        spaceId: page.spaceId,
        version: page.version?.number,
      },
    }))

    // `_links.next` is a RELATIVE URL ("/wiki/api/v2/pages?cursor=…&limit=25"),
    // not a cursor token. The sync engine round-trips nextCursor straight back
    // into the `cursor` query param above, so extract just the token — feeding
    // the whole URL back makes Confluence 400 and pagination silently stops
    // after one page.
    const next = data._links?.next
    return {
      entities,
      nextCursor: next ? new URL(`${baseUrl}${next}`).searchParams.get('cursor') : null,
    }
  }

  // ── Write surface (bidirectional-sync.md §3.2) — item-level page writes ──
  // Confluence is a document connector: pages get edited, commented on, and
  // archived — never board-mirrored, so listRemoteBoards/fetchBoardSnapshot
  // stay at the BaseConnector defaults.

  override get capabilities(): ConnectorCapabilities {
    return { write: ['update_item', 'comment', 'close_item'] as MutationKind[] }
  }

  override async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) {
      throw new Error(`Confluence connector for op ${envelope.opId} is missing baseUrl`)
    }
    const { op } = envelope
    switch (op.kind) {
      case 'update_item':
        return this.updatePage(baseUrl, op.ref, op.patch)
      case 'comment':
        return this.addFooterComment(baseUrl, op.ref, op.body)
      case 'close_item':
        return this.archivePage(baseUrl, op.ref)
      default:
        throw new UnsupportedMutationError(this.source, op.kind)
    }
  }

  // Confluence uses optimistic version locking: every PUT must carry the
  // current version number + 1, and the server rejects a stale write with a
  // 409 — which fetchWithRetry passes through and we surface as an error so
  // the outbox flags the conflict instead of silently clobbering.
  private async readPage(baseUrl: string, pageId: string): Promise<ConfluencePageDetail> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`,
      { headers: this.headers },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} reading Confluence page ${pageId}`)
    return await res.json() as ConfluencePageDetail
  }

  private async updatePage(
    baseUrl: string,
    ref: RemoteRef,
    patch: { title?: string; body?: string },
  ): Promise<MutationResult> {
    const current = await this.readPage(baseUrl, ref.remoteId)
    const nextVersion = (current.version?.number ?? 0) + 1
    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/api/v2/pages/${ref.remoteId}`,
      {
        method: 'PUT',
        headers: this.jsonHeaders,
        body: JSON.stringify({
          id: ref.remoteId,
          status: 'current',
          title: patch.title ?? current.title,
          body: {
            representation: 'storage',
            value: patch.body ?? current.body?.storage?.value ?? '',
          },
          version: { number: nextVersion },
        }),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} updating Confluence page ${ref.remoteId}`)
    const data = await res.json() as ConfluencePageDetail
    const version = data.version?.number ?? nextVersion
    return { ref, remoteVersion: String(version), raw: { version, status: 'current' } }
  }

  // close_item on a document connector = archive the page. The v2 update
  // endpoint only accepts status current/draft (PUTting 'archived' is a 400),
  // so this goes through the v1 archive endpoint, which queues a long-running
  // task. Archiving doesn't bump the page version → remoteVersion stays null.
  private async archivePage(baseUrl: string, ref: RemoteRef): Promise<MutationResult> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/rest/api/content/archive`,
      {
        method: 'POST',
        headers: this.jsonHeaders,
        body: JSON.stringify({ pages: [{ id: ref.remoteId }] }),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} archiving Confluence page ${ref.remoteId}`)
    const data = await res.json().catch(() => ({})) as { id?: string | number }
    return {
      ref,
      remoteVersion: null,
      raw: { archived: true, taskId: data.id != null ? String(data.id) : null },
    }
  }

  // Footer comments don't bump the page version → remoteVersion stays null.
  private async addFooterComment(baseUrl: string, ref: RemoteRef, body: string): Promise<MutationResult> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/api/v2/pages/${ref.remoteId}/footer-comments`,
      {
        method: 'POST',
        headers: this.jsonHeaders,
        body: JSON.stringify({ body: { representation: 'storage', value: body } }),
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} commenting on Confluence page ${ref.remoteId}`)
    const data = await res.json() as { id?: string | number }
    return { ref, remoteVersion: null, raw: { commentId: data.id != null ? String(data.id) : null } }
  }
}

interface ConfluenceSpaceList {
  results?: Array<{ id: string | number; key: string; name: string }>
  _links?: { next?: string }
}

interface ConfluencePageList {
  results: ConfluencePage[]
  _links: { next?: string }
}

interface ConfluencePage {
  id: string
  title: string
  status: string
  spaceId: string
  version: { number: number; createdAt: string } | null
  _links: { webui?: string }
}

interface ConfluencePageDetail {
  id: string
  title: string
  status: string
  version: { number: number } | null
  body?: { storage?: { value: string } } | null
}
