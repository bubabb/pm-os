import { getDb, costRecords, events } from '@creare/database'
import { generateId } from '@creare/shared'
import { and, eq, gte } from 'drizzle-orm'
import type { CostRecord, NewCostRecord } from '@creare/database'

export async function recordCost(input: Omit<NewCostRecord, 'id' | 'createdAt' | 'recordedAt'>): Promise<CostRecord> {
  const db = getDb()
  const [record] = await db
    .insert(costRecords)
    .values({ id: generateId(), ...input })
    .returning()
  // Append-only event log — every state change is an event (CLAUDE.md rule 2).
  db.insert(events).values({
    id: generateId(),
    type: 'cost.recorded',
    domain: 'reporting',
    projectId: input.projectId,
    actorType: 'system',
    actorId: null,
    resourceType: 'cost_record',
    resourceId: record!.id,
    payload: JSON.stringify({ agentWorkspaceId: input.agentWorkspaceId, costCents: input.costCents }),
  }).run()
  return record!
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
