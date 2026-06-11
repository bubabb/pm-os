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

  // ── Write surface (bidirectional-sync.md §3.2) — item-level file writes ──
  // OneDrive is a file connector: rename + move into a folder only — never
  // board-mirrored, so listRemoteBoards/fetchBoardSnapshot stay at the
  // BaseConnector defaults.

  override get capabilities(): ConnectorCapabilities {
    return { write: ['update_item', 'move_item'] as MutationKind[] }
  }

  override async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    const { op } = envelope
    switch (op.kind) {
      case 'update_item': {
        // Files have no body/labels — the only supported edit is a rename
        if (op.patch.title === undefined) {
          throw new Error(`update_item op ${envelope.opId}: OneDrive only supports renaming (patch.title is required)`)
        }
        return this.patchItem(envelope, op.ref, { name: op.patch.title })
      }
      case 'move_item':
        // toStatusRemoteId carries the target folder's drive-item id
        return this.patchItem(envelope, op.ref, { parentReference: { id: op.toStatusRemoteId } })
      default:
        throw new UnsupportedMutationError(this.source, op.kind)
    }
  }

  // Graph drive-item PATCH with optimistic concurrency: when the envelope
  // carries the eTag we last saw (baseVersion), send it as If-Match so a
  // remote edit since then fails with 412 instead of silently clobbering.
  private async patchItem(
    envelope: MutationEnvelope,
    ref: RemoteRef,
    payload: Record<string, unknown>,
  ): Promise<MutationResult> {
    const headers: Record<string, string> = { ...this.headers, 'Content-Type': 'application/json' }
    if (envelope.baseVersion) headers['If-Match'] = envelope.baseVersion

    const res = await this.fetchWithRetry(
      `${GRAPH_API}/me/drive/items/${ref.remoteId}`,
      { method: 'PATCH', headers, body: JSON.stringify(payload) },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status} patching OneDrive item ${ref.remoteId}`)

    const data = await res.json() as GraphDriveItemPatchResult
    const result: MutationResult = {
      ref,
      remoteVersion: data.eTag ?? null,
      raw: { name: data.name ?? null, eTag: data.eTag ?? null },
    }
    if (data.webUrl) result.remoteUrl = data.webUrl
    return result
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

interface GraphDriveItemPatchResult {
  id: string
  name?: string
  eTag?: string
  webUrl?: string
}
