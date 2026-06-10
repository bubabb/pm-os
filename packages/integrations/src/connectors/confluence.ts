import { BaseConnector } from './base'
import type { FetchResult, NormalizedEntity } from '../types'

export class ConfluenceConnector extends BaseConnector {
  get source() { return 'confluence' as const }

  private get headers() {
    const meta = this.config.metadata as { email?: string } | undefined
    const email = meta?.email ?? ''
    const encoded = Buffer.from(`${email}:${this.config.token}`).toString('base64')
    return { Authorization: `Basic ${encoded}`, Accept: 'application/json' }
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
