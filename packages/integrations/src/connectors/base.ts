import type {
  ConnectorCapabilities,
  ConnectorConfig,
  FetchResult,
  IntegrationSource,
  MirrorBoardSnapshot,
  MirrorItemSnapshot,
  MutationEnvelope,
  MutationKind,
  MutationResult,
  RemoteBoardOption,
  RemoteRef,
  ResourceOption,
} from '../types'

// Thrown when a mutation kind is pushed at a connector that can't perform it.
// The outbox worker treats this as fatal (no retry) — it signals a programming
// error or a capability mismatch, not a transient remote failure.
export class UnsupportedMutationError extends Error {
  constructor(source: IntegrationSource, kind: MutationKind) {
    super(`Connector "${source}" does not support the "${kind}" mutation`)
    this.name = 'UnsupportedMutationError'
  }
}

export abstract class BaseConnector {
  constructor(protected config: ConnectorConfig) {}

  abstract get source(): IntegrationSource
  abstract fetchEntities(cursor?: string): Promise<FetchResult>

  // Lists the resources (repos/projects/spaces/databases/folders) this
  // connection's token can access — powers the UI resource picker.
  // Default: no picker support; subclasses override.
  async listResources(): Promise<ResourceOption[]> {
    return []
  }

  // ── Board-mirror surface (docs/architecture/bidirectional-sync.md) ──
  // Defaults make every connector mirror-less; connectors that can mirror a
  // remote board (GitHub Projects v2, later Jira boards / Notion databases…)
  // override BOTH methods.

  // Remote boards this connection's token can mirror — powers the
  // "Import remote board" picker.
  async listRemoteBoards(): Promise<RemoteBoardOption[]> {
    return []
  }

  // Resolve ONE remote board from a user-supplied reference (a full board URL)
  // — the cross-owner import path for boards the token can access but that
  // listRemoteBoards' "own boards" enumeration never surfaces. null = the ref
  // didn't parse, or no such board is visible to this token; upstream
  // auth/scope failures still throw. Default: no resolution support.
  async resolveRemoteBoard(_ref: string): Promise<RemoteBoardOption | null> {
    return null
  }

  // Full normalized snapshot (columns + items) of one remote board — the pull
  // side of the mirror. mirror-sync calls this instead of any provider client.
  async fetchBoardSnapshot(_remoteBoardId: string): Promise<MirrorBoardSnapshot> {
    throw new Error(`${this.source} does not support board mirroring`)
  }

  // Single-item re-fetch: the item's CURRENT normalized snapshot, computed by
  // the SAME code path (normalize + hash) as fetchBoardSnapshot so its
  // contentHash matches exactly what the next pull will compute. The outbox
  // create-finalize step calls this to stamp remote_links.lastSyncedHash from
  // the item's REAL post-create state — including any status the platform
  // auto-assigned on create (Notion Status, a GitHub "set status on add"
  // workflow, Jira's initial workflow status) — so the next pull sees
  // contentHash === lastSyncedHash and does NOT emit a redundant remoteUpdate.
  // Returns null when the item can't be found. Default: mirror-less connectors
  // return null (the create-finalize path then falls back to any connector-
  // returned createdBaseline).
  async fetchItemSnapshot(_ref: RemoteRef): Promise<MirrorItemSnapshot | null> {
    return null
  }

  // ── Write surface (docs/architecture/bidirectional-sync.md §3.1) ──
  // Defaults make every connector read-only; writable connectors override.

  get capabilities(): ConnectorCapabilities {
    return { write: [] }
  }

  async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    throw new UnsupportedMutationError(this.source, envelope.op.kind)
  }

  // Cheap pre-push conflict probe — returns the remote's current version token
  // for a single object, or null when unknown/unsupported.
  async fetchRemoteVersion(_ref: RemoteRef): Promise<string | null> {
    return null
  }

  // Powers the Connections write-access badge. 'unknown' = cannot determine
  // (e.g. fine-grained PATs expose no scope header).
  async verifyWriteAccess(): Promise<'read_write' | 'read_only' | 'unknown'> {
    return 'unknown'
  }

  protected async fetchWithRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
    let lastError: Error = new Error('Unknown fetch error')
    for (let i = 0; i < attempts; i++) {
      let res: Response
      try {
        res = await fetch(url, init)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        await sleep(500 * Math.pow(2, i))
        continue
      }
      // Auth failures are fatal — throw so the sync is marked as an error
      // instead of being treated as an empty successful fetch. EXCEPT: GitHub
      // signals rate limiting as 403 + Retry-After / X-RateLimit-Remaining: 0,
      // which must retry like a 429, not fail as bad auth.
      if (res.status === 401 || (res.status === 403 && !isRateLimit403(res))) {
        throw new Error(`HTTP ${res.status} from ${url}`)
      }
      // Rate limits (429 + rate-limited 403) and server errors: retry with
      // backoff (honoring Retry-After when present), throw if exhausted
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${url}`)
        await sleep(retryDelayMs(res, i))
        continue
      }
      // 404 is non-fatal — connectors treat !res.ok as "no data available"
      return res
    }
    throw lastError
  }
}

// A 403 that is really a rate limit, not an auth failure (GitHub REST uses
// 403 for both): Retry-After present, or the primary rate limit is exhausted.
function isRateLimit403(res: Response): boolean {
  return res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0'
}

// Backoff delay for a retryable response — honors Retry-After (seconds,
// capped at 10s) when sent, exponential backoff otherwise.
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after')
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 10_000) : 500 * Math.pow(2, attempt)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
