import { generateId } from '@pm-os/shared'
import type { NewExternalEventCache } from '@pm-os/database'
import type { NormalizedEntity } from './types'

export function toExternalEventCacheRow(
  entity: NormalizedEntity,
  credentialId: string,
  projectId: string,
): NewExternalEventCache {
  return {
    id: generateId(),
    projectId,
    credentialId,
    source: entity.source,
    entityType: entity.entityType,
    entityId: entity.entityId,
    entityUrl: entity.entityUrl,
    payload: JSON.stringify(entity),
    fetchedAt: new Date().toISOString(),
    purgedAt: null,
    createdAt: new Date().toISOString(),
  }
}
