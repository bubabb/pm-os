# Agent Task: Phase 2 — Domain 6: Integrations

---
status: ready
phase: 2
task-id: 21
blocked-by: [20]
---

## Before You Start
Read in order:
1. `/project-scope.md` §5 Domain 6
2. `/packages/integrations/CLAUDE.md`
3. `/packages/integrations/CONTRACT.md`
4. `/packages/database/src/schema.ts` — focus on integration_* and external_event_cache tables
5. `/packages/ai-sdk/src/index.ts` — complete() interface
6. `agent-state/handoffs/phase1-task4-output.md` — getIntegrationToken() is in apps/desktop

## Architecture Note
`packages/integrations` cannot import from `apps/desktop` (circular dep).
**Token injection pattern:** all connectors receive a plaintext token as a constructor argument.
The desktop app fetches the token via `getIntegrationToken()` before calling any sync operation.

## Your Scope
You own: `packages/integrations/src/**`

## What You Must Produce

### 1. Package setup
- `packages/integrations/package.json`
- `packages/integrations/tsconfig.json`

### 2. Types (`src/types.ts`)
```typescript
type IntegrationSource = 'jira' | 'github' | 'confluence' | 'notion' | 'onedrive'
type ActionBucket = 'human' | 'agent'

interface NormalizedEntity {
  source: IntegrationSource
  entityType: string   // 'ticket' | 'pr' | 'page' | 'note' | 'file'
  entityId: string     // source-system ID
  entityUrl: string | null
  title: string
  status: string | null
  assignee: string | null
  updatedAt: string | null
  raw: Record<string, unknown>   // source-specific fields for correlation
}

interface ClassifiedItem {
  entity: NormalizedEntity
  bucket: ActionBucket
  urgency: 1 | 2 | 3 | 4 | 5
  riskType: string | null
  suggestedAction: string
}

interface SyncStatus {
  credentialId: string
  source: IntegrationSource
  status: 'idle' | 'syncing' | 'error'
  lastSyncedAt: string | null
  lastErrorMessage: string | null
}

interface ConnectorConfig {
  credentialId: string
  projectId: string
  token: string               // plaintext — injected by desktop app
  baseUrl?: string            // required for Jira, Confluence
  metadata?: Record<string, unknown>
}
```

### 3. Base connector (`src/connectors/base.ts`)
```typescript
abstract class BaseConnector {
  constructor(protected config: ConnectorConfig) {}
  abstract fetchEntities(cursor?: string): Promise<{ entities: NormalizedEntity[]; nextCursor: string | null }>
  abstract get source(): IntegrationSource
}
```

### 4. Source connectors (`src/connectors/`)
Build all five. Each fetches and normalizes entities.

**GitHub** (`github.ts`) — REST API (`https://api.github.com`)
- Fetch open PRs: `GET /repos/{owner}/{repo}/pulls?state=open`
- Fetch recent issues: `GET /repos/{owner}/{repo}/issues?state=open`
- Auth: `Authorization: Bearer {token}`
- `baseUrl` metadata: `{ owner, repo }`
- Extract Jira ticket IDs from PR title and branch name for correlation

**Jira** (`jira.ts`) — Jira Cloud REST API v3
- Fetch assigned/open issues: `GET {baseUrl}/rest/api/3/search?jql=assignee=currentUser() AND status != Done`
- Auth: `Authorization: Basic base64(email:token)`
- `baseUrl` metadata: `{ email }` (for Basic auth)

**Confluence** (`confluence.ts`) — Confluence Cloud REST API v2
- Fetch recently updated pages: `GET {baseUrl}/wiki/api/v2/pages?sort=-modified-date&limit=25`
- Auth: `Authorization: Basic base64(email:token)`

**Notion** (`notion.ts`) — Notion REST API
- Fetch database items: `POST https://api.notion.com/v1/databases/{databaseId}/query`
- Auth: `Authorization: Bearer {token}`
- `baseUrl` metadata: `{ databaseId }`

**OneDrive** (`onedrive.ts`) — Microsoft Graph API
- Fetch recent files: `GET https://graph.microsoft.com/v1.0/me/drive/recent`
- Auth: `Authorization: Bearer {token}`

All connectors must: wrap fetch with 3-attempt exponential backoff, return `[]` on non-fatal errors (404, 403), throw on 5xx.

### 5. Normalizer (`src/normalizer.ts`)
- `toExternalEventCacheRow(entity: NormalizedEntity, credentialId: string, projectId: string): NewExternalEventCache`
- Maps NormalizedEntity to DB insert shape

### 6. Sync engine (`src/sync-engine.ts`)
- `SyncEngine` class
- `sync(credential: IntegrationCredential, token: string): Promise<{ itemsFetched: number }>`
  1. Updates sync state to `syncing`
  2. Instantiates correct connector for `credential.source`
  3. Fetches entities page by page until no nextCursor
  4. Soft-purges stale cached rows (sets `purgedAt`) for this credential before writing new ones
  5. Inserts fresh rows to `external_event_cache`
  6. Updates sync state to `idle` with new cursor + `lastSyncedAt`
  7. Writes `integration.sync.completed` event to event log
  8. On error: updates sync state to `error`, writes `integration.sync.failed` event

### 7. Correlator (`src/correlator.ts`)
- `correlateEntities(entityId: string, source: IntegrationSource, projectId: string): Promise<ExternalEventCache[]>`
- MVP: Jira ↔ GitHub only
  - If source is `github`: extract ticket IDs from entity raw (title, branchName) using regex `/([A-Z]+-\d+)/g`, then query `external_event_cache` for matching Jira tickets
  - If source is `jira`: query `external_event_cache` for GitHub PRs whose raw payload contains the Jira ID in title or branch
- Returns empty array on no match (best-effort, never false positives)

### 8. Classifier (`src/classifier.ts`)
Two-stage: rule engine first (no LLM cost), LLM fallback for ambiguous items.

**Stage 1 — Rule engine:**
```
ALWAYS human:
- entityType === 'pr' AND raw.isDraft === false AND raw.requestedReviewers > 0 → 'human', urgency 4
- title contains /budget|sign.?off|escalat|architect/i → 'human', urgency 5
- raw.labels contains 'security' → 'human', urgency 5

ALWAYS agent:
- entityType === 'ticket' AND raw.labels === [] AND raw.assignee === null → 'agent', urgency 2
- entityType === 'file' AND source === 'onedrive' → 'agent' (summarise meeting notes), urgency 2
- entityType === 'page' AND source === 'confluence' → 'agent' (check doc drift), urgency 1

AMBIGUOUS (pass to Stage 2): everything else
```

**Stage 2 — LLM classifier (for ambiguous items only):**
- Call `complete()` from `@creare/ai-sdk` with `provider: 'anthropic'`, `model: 'claude-haiku-4-5-20251001'`
- System prompt: "You are a PM action classifier. Given a DevOps entity, decide if it requires human judgment (approve, escalate, strategic decision) or can be handled by an AI agent (summarise, label, update). Respond with JSON only: { bucket: 'human'|'agent', urgency: 1-5, riskType: string|null, suggestedAction: string }"
- Parse JSON response; fall back to `{ bucket: 'human', urgency: 3, riskType: null, suggestedAction: 'Review manually' }` on parse error

### 9. Digest generator (`src/digest-generator.ts`)
- `generateDigest(projectId: string, digestType: PmDigestCache['digestType'], items: ClassifiedItem[]): Promise<PmDigestCache>`
- Calls `complete()` with Haiku to produce the digest content based on items
- Writes result to `pm_digest_cache` with `validUntil = now + 15 minutes`
- `getLatestDigest(projectId, digestType)`: returns cached digest if `validUntil` is in the future, else null

### 10. Public index (`src/index.ts`)
Export the full public API matching CONTRACT.md:
```typescript
export async function triggerSync(projectId: string, credentials: Array<{ credential: IntegrationCredential; token: string }>, source?: IntegrationSource): Promise<void>
export async function getSyncStatus(projectId: string): Promise<SyncStatus[]>
export async function getActiveEvents(projectId: string, filters?: { sources?: IntegrationSource[]; entityTypes?: string[]; since?: string }): Promise<ExternalEventCache[]>
export async function correlateEntities(entityId: string, source: IntegrationSource, projectId: string): Promise<ExternalEventCache[]>
export async function classifyItems(projectId: string, items: ExternalEventCache[]): Promise<ClassifiedItem[]>
export async function generateDigest(projectId: string, digestType: PmDigestCache['digestType'], credentials: Array<{ credential: IntegrationCredential; token: string }>): Promise<PmDigestCache>
export async function getLatestDigest(projectId: string, digestType: PmDigestCache['digestType']): Promise<PmDigestCache | null>
export type { IntegrationSource, ClassifiedItem, SyncStatus, NormalizedEntity, ConnectorConfig }
```

### 11. Desktop app routes (`apps/desktop/src/main/routes/integrations.ts`)
- `GET /projects/:id/integrations` — list credentials (no tokens)
- `POST /projects/:id/integrations` — store new credential (body: { source, label, token, metadata?, expiresAt? })
- `DELETE /projects/:id/integrations/:credentialId` — remove credential
- `POST /projects/:id/integrations/sync` — trigger sync for all credentials (or body: { source } for one source). Fetches tokens via getIntegrationToken(), calls triggerSync().
- `GET /projects/:id/integrations/status` — getSyncStatus()
- `GET /projects/:id/integrations/events` — getActiveEvents() with optional ?source=&entityType=&since= query params

## Done When
- [ ] All 5 connectors compile and return typed NormalizedEntity arrays
- [ ] SyncEngine writes to external_event_cache and integration_sync_state
- [ ] Correlator matches Jira IDs in GitHub PR titles/branches
- [ ] Classifier correctly routes obvious cases via rule engine (no LLM call)
- [ ] Classifier calls LLM for ambiguous items and parses response
- [ ] generateDigest writes to pm_digest_cache with correct validUntil
- [ ] All desktop routes respond correctly (auth-protected)
- [ ] TypeScript compiles with zero errors
- [ ] Handoff file written to agent-state/handoffs/phase2-domain6-output.md
- [ ] Session log written to docs/sessions/
