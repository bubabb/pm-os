import { BaseConnector } from './base'
import type { FetchResult, NormalizedEntity } from '../types'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

export class NotionConnector extends BaseConnector {
  get source() { return 'notion' as const }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    }
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
    if (!res.ok) return { entities: [], nextCursor: null }

    const data = await res.json() as NotionQueryResult
    const entities: NormalizedEntity[] = data.results.map((page) => {
      const title = extractNotionTitle(page.properties)
      return {
        source: 'notion' as const,
        entityType: 'note',
        entityId: page.id,
        entityUrl: page.url,
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

interface NotionQueryResult {
  results: NotionPage[]
  has_more: boolean
  next_cursor: string | null
}

interface NotionPage {
  id: string
  url: string
  last_edited_time: string
  properties: Record<string, NotionProperty>
}

interface NotionProperty {
  type: string
  title?: Array<{ plain_text: string }>
  status?: { name: string }
  select?: { name: string }
}
