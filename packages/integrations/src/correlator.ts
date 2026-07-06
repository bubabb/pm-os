import { getDb, externalEventCache } from '@pm-os/database'
import { eq, and, isNull, like, or } from 'drizzle-orm'
import type { ExternalEventCache } from '@pm-os/database'
import type { IntegrationSource } from './types'

// Cross-source entity correlation — MVP: Jira ↔ GitHub only.
// Best-effort: returns [] on no match. Never returns a false positive.
export async function correlateEntities(
  entityId: string,
  source: IntegrationSource,
  projectId: string,
): Promise<ExternalEventCache[]> {
  const db = getDb()
  const baseConditions = [
    eq(externalEventCache.projectId, projectId),
    isNull(externalEventCache.purgedAt),
  ]

  if (source === 'github') {
    // Entity is a GitHub PR — look for Jira ticket IDs embedded in the PR payload
    const [row] = await db
      .select()
      .from(externalEventCache)
      .where(
        and(
          ...baseConditions,
          eq(externalEventCache.source, 'github'),
          eq(externalEventCache.entityId, entityId),
        ),
      )
      .limit(1)

    if (!row) return []

    const entity = (() => {
      try { return JSON.parse(row.payload) as { raw?: { ticketIds?: string[] } } }
      catch { return null }
    })()

    const ticketIds = entity?.raw?.ticketIds ?? []
    if (ticketIds.length === 0) return []

    // Find matching Jira tickets in cache
    const jiraMatches = await Promise.all(
      ticketIds.map((id) =>
        db
          .select()
          .from(externalEventCache)
          .where(
            and(
              ...baseConditions,
              eq(externalEventCache.source, 'jira'),
              eq(externalEventCache.entityId, id),
            ),
          )
          .limit(1),
      ),
    )

    return jiraMatches.flat().filter((r): r is ExternalEventCache => r !== undefined)
  }

  if (source === 'jira') {
    // Entity is a Jira ticket — look for GitHub PRs that reference this ticket ID
    const rows = await db
      .select()
      .from(externalEventCache)
      .where(
        and(
          ...baseConditions,
          eq(externalEventCache.source, 'github'),
          // payload contains the Jira ticket ID — use a LIKE search as best-effort
          or(
            like(externalEventCache.payload, `%"${entityId}"%`),
          ),
        ),
      )
      .limit(10)

    // Verify matches by parsing payload — prevents false positives from partial string matches
    return rows.filter((row) => {
      try {
        const entity = JSON.parse(row.payload) as { raw?: { ticketIds?: string[] } }
        return entity.raw?.ticketIds?.includes(entityId) === true
      } catch {
        return false
      }
    })
  }

  return []
}
