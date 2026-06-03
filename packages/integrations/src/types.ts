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

export interface FetchResult {
  entities: NormalizedEntity[]
  nextCursor: string | null
}
