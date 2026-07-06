export type IntegrationSource = 'jira' | 'github' | 'confluence' | 'notion' | 'onedrive'
export type ActionBucket = 'human' | 'agent'

export interface NormalizedEntity {
  source: IntegrationSource
  entityType: string       // 'ticket' | 'pr' | 'page' | 'note' | 'file'
  entityId: string         // source-system identifier
  entityUrl: string | null
  title: string
  status: string | null
  assignee: string | null
  updatedAt: string | null
  raw: Record<string, unknown>  // source-specific fields, used for correlation
}

export interface ClassifiedItem {
  entity: NormalizedEntity
  bucket: ActionBucket
  urgency: 1 | 2 | 3 | 4 | 5
  riskType: string | null
  suggestedAction: string
}

export interface SyncStatus {
  credentialId: string
  source: IntegrationSource
  status: 'idle' | 'syncing' | 'error'
  lastSyncedAt: string | null
  lastErrorMessage: string | null
}

export interface ConnectorConfig {
  credentialId: string
  projectId: string
  token: string                          // plaintext — injected by desktop app, never stored here
  baseUrl?: string                       // required for Jira, Confluence
  metadata?: Record<string, unknown>     // source-specific config (owner, repo, email, databaseId…)
}

// A pickable resource (repo/project/space/database/folder) the connection's
// token can access. `metadata` is the per-project scope to persist when this
// resource is picked (e.g. github → {owner, repo}; jira → {projectKey}).
export interface ResourceOption {
  id: string
  label: string
  sublabel?: string
  metadata: Record<string, string>
}

export interface FetchResult {
  entities: NormalizedEntity[]
  nextCursor: string | null
}

// ── Bidirectional sync (docs/architecture/bidirectional-sync.md §3.1, §6.1) ──

export type MutationKind =
  | 'create_item' | 'update_item' | 'move_item'
  | 'comment' | 'close_item' | 'reopen_item' | 'archive_item'

// Provider-agnostic pointer to a remote object.
export interface RemoteRef {
  remoteType: string        // 'pv2_item' | 'issue' | 'pr' | 'ticket' | 'page' | 'db_page' | 'file'
  remoteId: string
  containerId?: string      // ProjectV2 node id / 'owner/repo' / projectKey / databaseId / driveId
}

// `force` (update/close/reopen): last-write-wins override. When set, the outbox
// pre-push drift probe overwrites the remote even if it moved off base, instead
// of parking a conflict — used by conflict resolution's local_wins to make the
// LOCAL delta actually win (not just the column move). Absent on the normal
// enqueue path, so routine edits still conflict-guard.
export type MutationOp =
  | { kind: 'move_item';    ref: RemoteRef; toStatusRemoteId: string; statusFieldRemoteId?: string }
  | { kind: 'create_item';  container: RemoteRef; title: string; body?: string; itemType?: string; fields?: Record<string, string> }
  | { kind: 'update_item';  ref: RemoteRef; patch: { title?: string; body?: string; assignee?: string | null; labels?: string[]; fields?: Record<string, string> }; force?: true }
  | { kind: 'comment';      ref: RemoteRef; body: string }
  | { kind: 'close_item';   ref: RemoteRef; reason?: string; force?: true }
  | { kind: 'reopen_item';  ref: RemoteRef; force?: true }
  | { kind: 'archive_item'; ref: RemoteRef }

export interface MutationEnvelope {
  opId: string
  credentialId: string
  projectId: string
  source: IntegrationSource
  baseVersion: string | null
  op: MutationOp
}

// Normalized baseline of an item a create_item just minted remotely, computed
// the SAME way each connector's pull snapshot computes an item (title +
// statusRemoteId + state + archived — the fields that feed MirrorItemSnapshot.
// contentHash = stableHash({ title, statusRemoteId, state, archived })). The
// outbox stamps remote_links.lastSyncedHash from these RETURNED values so the
// very next pull sees contentHash === lastSyncedHash and does NOT revert the
// freshly created card. Never a hardcoded guess — GitHub drafts pull back
// state:'draft'/statusRemoteId:null, Jira pulls back a real status id, etc.
export interface CreatedItemBaseline {
  remoteId: string
  title: string
  statusRemoteId: string | null
  state: 'open' | 'closed' | 'draft'
  archived: boolean
}

export interface MutationResult {
  ref: RemoteRef
  remoteVersion: string | null
  remoteUrl?: string
  raw: Record<string, unknown>
  // Present only on a successful create_item — the pull-equivalent baseline of
  // the item just created (see CreatedItemBaseline).
  createdBaseline?: CreatedItemBaseline
}

export interface ConnectorCapabilities { write: MutationKind[] }

// Mirror snapshot shapes (normalized across connectors)
export interface MirrorColumnSnapshot { remoteId: string; name: string; position: number; isTerminal: boolean }
export interface MirrorItemSnapshot {
  remoteId: string; containerRemoteId: string; title: string; url: string | null
  statusRemoteId: string | null; state: 'open' | 'closed' | 'draft'
  archived: boolean; version: string; contentHash: string
}
export interface MirrorBoardSnapshot {
  remoteId: string; title: string; url: string | null; version: string
  statusFieldRemoteId: string | null
  columns: MirrorColumnSnapshot[]; items: MirrorItemSnapshot[]
}
export interface RemoteBoardOption { id: string; label: string; sublabel?: string; url?: string }
