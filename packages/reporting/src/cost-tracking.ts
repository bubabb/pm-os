import { getDb, costRecords, events } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { and, eq, gte } from 'drizzle-orm'
import type { CostRecord, NewCostRecord } from '@pm-os/database'

export async function recordCost(input: Omit<NewCostRecord, 'id' | 'createdAt' | 'recordedAt'>): Promise<CostRecord> {
  const db = getDb()
  // Both inserts commit together in one transaction — the better-sqlite3 driver only
  // supports synchronous transaction callbacks, so use .get()/.run() here rather than await.
  const record = db.transaction((tx) => {
    const row = tx
      .insert(costRecords)
      .values({ id: generateId(), ...input })
      .returning()
      .get()
    // Append-only event log — every state change is an event (CLAUDE.md rule 2).
    tx.insert(events).values({
      id: generateId(),
      type: 'cost.recorded',
      domain: 'reporting',
      projectId: input.projectId,
      actorType: 'system',
      actorId: null,
      resourceType: 'cost_record',
      resourceId: row.id,
      payload: JSON.stringify({ agentWorkspaceId: input.agentWorkspaceId, costCents: input.costCents }),
    }).run()
    return row
  })
  return record
}

export async function getProjectSpend(
  projectId: string,
  since?: string,
): Promise<{ totalCents: number; byWorkspace: Record<string, number> }> {
  const db = getDb()
  const conditions = [eq(costRecords.projectId, projectId)]
  if (since) conditions.push(gte(costRecords.recordedAt, since))

  const rows = await db
    .select({
      agentWorkspaceId: costRecords.agentWorkspaceId,
      costCents: costRecords.costCents,
    })
    .from(costRecords)
    .where(and(...conditions))

  let totalCents = 0
  const byWorkspace: Record<string, number> = {}
  for (const row of rows) {
    totalCents += row.costCents
    byWorkspace[row.agentWorkspaceId] = (byWorkspace[row.agentWorkspaceId] ?? 0) + row.costCents
  }

  return { totalCents, byWorkspace }
}
