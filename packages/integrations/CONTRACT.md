# Integrations — Interface Contract
---
status: active
version: 1.0
last-updated: 2026-06-03
---

## Schema Types Consumed
From `@pm-os/database`:
```typescript
import type {
  IntegrationCredential, NewIntegrationCredential,
  IntegrationSyncState,  NewIntegrationSyncState,
  ExternalEventCache,    NewExternalEventCache,
  PmDigestCache,         NewPmDigestCache,
  UserSetting,
} from '@pm-os/database'
```

## Schema Types Written
This domain writes to: `integration_sync_state`, `external_event_cache`, `pm_digest_cache`, `events`.
It reads from: `integration_credentials` (via the secrets service — never direct decryption).

## Events Emitted to Event Log
All events use `domain: 'integrations'`.

| Event Type | Trigger | Payload |
|---|---|---|
| `integration.sync.started` | Sync cycle begins for a source | `{ credentialId, source, projectId }` |
| `integration.sync.completed` | Sync cycle completes successfully | `{ credentialId, source, projectId, itemsFetched }` |
| `integration.sync.failed` | Sync cycle errors | `{ credentialId, source, projectId, error }` |
| `integration.credential.expired` | Token expiry detected | `{ credentialId, source, projectId }` |

## Public API (finalized in Phase 2)
```typescript
// Sync control
triggerSync(projectId: string, source?: IntegrationSource): Promise<void>
getSyncStatus(projectId: string): Promise<SyncStatus[]>

// External event access (Domain 5 reads these)
getActiveEvents(projectId: string, filters?: {
  sources?: IntegrationSource[]
  entityTypes?: string[]
  since?: string
}): Promise<ExternalEventCache[]>

// Cross-source correlation
correlateEntities(entityId: string, source: IntegrationSource): Promise<ExternalEventCache[]>

// PM action classifier
classifyItems(projectId: string, items: ExternalEventCache[]): Promise<ClassifiedItem[]>
// ClassifiedItem: { item, bucket: 'human' | 'agent', urgency: 1 | 2 | 3 | 4 | 5, riskType: string | null, suggestedAction: string }

// PM digest generation
generateDigest(projectId: string, digestType: PmDigestCache['digestType']): Promise<PmDigestCache>
getLatestDigest(projectId: string, digestType: PmDigestCache['digestType']): Promise<PmDigestCache | null>
```

## Integration Sources
```typescript
type IntegrationSource = 'jira' | 'github' | 'confluence' | 'notion' | 'onedrive'
```

## Dependencies
- `@pm-os/database` — reads/writes integration tables and event log
- `@pm-os/shared` — `generateId()`
- `@pm-os/ai-sdk` — LLM fallback in two-stage classifier, digest generation
- `apps/desktop/src/main/secrets` — `getIntegrationToken()` for OAuth token access

## Consumed By
- `packages/reporting` — reads classified items and digests to power PM Command Center
- `apps/desktop` — sync trigger UI, integration settings screens
