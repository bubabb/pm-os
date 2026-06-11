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
  override async listResources(): Promise<ResourceOption[]> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return []

    const res = await this.fetchWithRetry(
      `${baseUrl}/wiki/api/v2/spaces?limit=100`,
      { headers: this.headers },
    )
    if (!res.ok) return []

    const data = await res.json() as ConfluenceSpaceList
    return (data.results ?? []).map((space) => ({
      id: String(space.id),
      label: space.name,
      sublabel: space.key,
      metadata: { spaceId: String(space.id) },
    }))
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
    if (!res.ok) return { entities: [], nextCursor: null }

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
        spaceKey: page.spaceId,
        version: page.version?.number,
      },
    }))

    return {
      entities,
      nextCursor: data._links?.next ? data._links.next : null,
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

  private async putPage(
    baseUrl: string,
    ref: RemoteRef,
    status: 'current' | 'archived',
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
          status,
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
    return { ref, remoteVersion: String(version), raw: { version, status } }
  }

  private async updatePage(
    baseUrl: string,
    ref: RemoteRef,
    patch: { title?: string; body?: string },
  ): Promise<MutationResult> {
    return this.putPage(baseUrl, ref, 'current', patch)
  }

  // close_item on a document connector = archive the page (still a version
  // bump, so the same read-then-PUT dance applies).
  private async archivePage(baseUrl: string, ref: RemoteRef): Promise<MutationResult> {
    return this.putPage(baseUrl, ref, 'archived', {})
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
