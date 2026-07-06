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

// Sentinel driveId for the user's own drive. Items in the signed-in user's
// drive are addressed as /me/drive/items/{id}; everything else (items shared
// FROM another user's drive) must go through /drives/{driveId}/items/{id}.
// Using a sentinel avoids an extra /me/drive round-trip just to learn the id.
const OWN_DRIVE = 'me'

// Safety cap when following @odata.nextLink in the resource picker
// (200 items/page → up to 2000 folders, plenty for a picker).
const MAX_LIST_PAGES = 10

// HTTP 412: the If-Match eTag we sent (baseVersion) no longer matches — the
// item changed remotely since our last sync. Distinct from a generic HTTP
// failure so the outbox worker treats it as a retryable conflict (re-probe
// the remote version on the next drain pass) instead of parking the op.
export class OneDriveConflictError extends Error {
  readonly retryable = true as const
  constructor(message: string) {
    super(message)
    this.name = 'OneDriveConflictError'
  }
}

export class OneDriveConnector extends BaseConnector {
  get source() { return 'onedrive' as const }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    }
  }

  // Folders the token can sync — powers the folder picker. Merges two Graph
  // surfaces: top-level folders of the user's OWN drive, plus folders shared
  // WITH the user (which live in OTHER people's drives and never appear under
  // /me/drive/root). Every option carries {driveId, itemId} so fetchEntities
  // and mutations can address the item in whichever drive actually owns it.
  override async listResources(): Promise<ResourceOption[]> {
    const [own, shared] = await Promise.all([
      this.collectPages<GraphChildItem>(
        `${GRAPH_API}/me/drive/root/children?$top=200&$select=id,name,folder`,
      ),
      this.collectPages<GraphSharedItem>(
        `${GRAPH_API}/me/drive/sharedWithMe?$top=200`,
      ),
    ])

    // Keyed by itemId — dedupes a folder that shows up via both surfaces.
    const options = new Map<string, ResourceOption>()

    for (const item of own) {
      if (item.folder == null) continue
      options.set(item.id, {
        id: item.id,
        label: item.name,
        metadata: { driveId: OWN_DRIVE, itemId: item.id, folder: item.name },
      })
    }

    // sharedWithMe returns stub DriveItems whose remoteItem facet points at
    // the real item in the SHARER's drive. That {driveId, itemId} pair is the
    // only valid address — /me/drive/items/{stub-id} does NOT resolve it.
    for (const item of shared) {
      const remote = item.remoteItem
      if (remote === undefined) continue
      const driveId = remote.parentReference?.driveId
      const itemId = remote.id
      if (driveId === undefined || itemId === undefined) continue
      if (item.folder == null && remote.folder == null) continue
      if (options.has(itemId)) continue

      const name = item.name ?? remote.name ?? 'Unnamed folder'
      const sharer = remote.shared?.sharedBy?.user?.displayName
      options.set(itemId, {
        id: itemId,
        label: sharer !== undefined ? `${name} (shared by ${sharer})` : `${name} (shared)`,
        metadata: { driveId, itemId, folder: name },
      })
    }

    return [...options.values()]
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    // The cursor is the verbatim @odata.nextLink URL from the previous page —
    // Graph encodes all paging state ($skipToken etc.) into it.
    const url = cursor ?? this.initialFetchUrl()
    const res = await this.fetchWithRetry(url, { headers: this.headers })
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`OneDrive fetch failed (HTTP ${res.status}): ${snippet}`)
    }

    const data = await res.json() as GraphDriveItemPage
    const entities: NormalizedEntity[] = (data.value ?? []).map((item) => ({
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

    return { entities, nextCursor: data['@odata.nextLink'] ?? null }
  }

  // First-page URL for fetchEntities. A picker-bound source carries
  // {driveId, itemId} and syncs that folder's children — including folders
  // shared from another user's drive. Unscoped sources (no metadata) and
  // legacy bindings (manual-entry {folder} only, pre-{driveId,itemId}) keep
  // the old account-wide recent-files behavior instead of crashing.
  private initialFetchUrl(): string {
    const meta = this.config.metadata as { driveId?: unknown; itemId?: unknown } | undefined
    const driveId = typeof meta?.driveId === 'string' ? meta.driveId : null
    const itemId = typeof meta?.itemId === 'string' ? meta.itemId : null
    const query = '$top=50&$select=id,name,webUrl,lastModifiedDateTime,lastModifiedBy'

    if (driveId !== null && itemId !== null) {
      const base = driveId === OWN_DRIVE
        ? `${GRAPH_API}/me/drive/items/${itemId}/children`
        : `${GRAPH_API}/drives/${driveId}/items/${itemId}/children`
      return `${base}?${query}`
    }
    return `${GRAPH_API}/me/drive/recent?${query}`
  }

  // Accumulates a paged Graph collection by following @odata.nextLink.
  private async collectPages<T>(firstUrl: string): Promise<T[]> {
    const items: T[] = []
    let url: string | null = firstUrl
    for (let page = 0; page < MAX_LIST_PAGES && url !== null; page++) {
      const res = await this.fetchWithRetry(url, { headers: this.headers })
      if (!res.ok) break
      const data = await res.json() as GraphPage<T>
      items.push(...(data.value ?? []))
      url = data['@odata.nextLink'] ?? null
    }
    return items
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
  // ref.containerId carries the owning driveId (RemoteRef convention) — items
  // in shared drives are only reachable via /drives/{driveId}/items/{id}.
  private async patchItem(
    envelope: MutationEnvelope,
    ref: RemoteRef,
    payload: Record<string, unknown>,
  ): Promise<MutationResult> {
    const headers: Record<string, string> = { ...this.headers, 'Content-Type': 'application/json' }
    if (envelope.baseVersion) headers['If-Match'] = envelope.baseVersion

    const driveId = ref.containerId
    const itemUrl = driveId !== undefined && driveId !== OWN_DRIVE
      ? `${GRAPH_API}/drives/${driveId}/items/${ref.remoteId}`
      : `${GRAPH_API}/me/drive/items/${ref.remoteId}`

    const res = await this.fetchWithRetry(
      itemUrl,
      { method: 'PATCH', headers, body: JSON.stringify(payload) },
    )
    if (res.status === 412) {
      throw new OneDriveConflictError(
        `OneDrive item ${ref.remoteId} changed remotely since the last sync (If-Match rejected with HTTP 412)`,
      )
    }
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

interface GraphPage<T> {
  value?: T[]
  '@odata.nextLink'?: string
}

interface GraphChildItem {
  id: string
  name: string
  folder?: { childCount: number } | null
}

// Stub returned by /me/drive/sharedWithMe — the remoteItem facet addresses
// the real item in the sharer's drive.
interface GraphSharedItem {
  id: string
  name?: string
  folder?: { childCount: number } | null
  remoteItem?: {
    id?: string
    name?: string
    folder?: { childCount: number } | null
    parentReference?: { driveId?: string }
    shared?: { sharedBy?: { user?: { displayName?: string } } }
  }
}

type GraphDriveItemPage = GraphPage<GraphDriveItem>

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
