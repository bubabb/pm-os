import { BaseConnector } from './base'
import type { FetchResult, NormalizedEntity, ResourceOption } from '../types'

const GRAPH_API = 'https://graph.microsoft.com/v1.0'

export class OneDriveConnector extends BaseConnector {
  get source() { return 'onedrive' as const }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    }
  }

  // Top-level folders in the user's drive — powers the folder picker
  override async listResources(): Promise<ResourceOption[]> {
    const res = await this.fetchWithRetry(
      `${GRAPH_API}/me/drive/root/children?$top=200&$select=id,name,folder`,
      { headers: this.headers },
    )
    if (!res.ok) return []

    const data = await res.json() as GraphChildList
    return (data.value ?? [])
      .filter((item) => item.folder != null)
      .map((item) => ({
        id: item.id,
        label: item.name,
        metadata: { folder: item.name },
      }))
  }

  async fetchEntities(_cursor?: string): Promise<FetchResult> {
    const res = await this.fetchWithRetry(
      `${GRAPH_API}/me/drive/recent?$top=50&$select=id,name,webUrl,lastModifiedDateTime,lastModifiedBy`,
      { headers: this.headers },
    )
    if (!res.ok) return { entities: [], nextCursor: null }

    const data = await res.json() as GraphDriveItemList
    const entities: NormalizedEntity[] = data.value.map((item) => ({
      source: 'onedrive' as const,
      entityType: 'file',
      entityId: item.id,
      entityUrl: item.webUrl,
      title: item.name,
      status: null,
      assignee: item.lastModifiedBy?.user?.displayName ?? null,
      updatedAt: item.lastModifiedDateTime,
      raw: { name: item.name },
    }))

    // Microsoft Graph uses @odata.nextLink for pagination — single page for MVP
    return { entities, nextCursor: null }
  }
}

interface GraphChildList {
  value?: Array<{ id: string; name: string; folder?: { childCount: number } | null }>
}

interface GraphDriveItemList {
  value: GraphDriveItem[]
}

interface GraphDriveItem {
  id: string
  name: string
  webUrl: string
  lastModifiedDateTime: string
  lastModifiedBy: { user?: { displayName: string } } | null
}
