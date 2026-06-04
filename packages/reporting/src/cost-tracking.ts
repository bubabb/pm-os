import { getDb, costRecords } from '@creare/database'
import { generateId } from '@creare/shared'
import { and, eq, gte, sum } from 'drizzle-orm'
import type { CostRecord, NewCostRecord } from '@creare/database'

export async function recordCost(input: Omit<NewCostRecord, 'id' | 'createdAt' | 'recordedAt'>): Promise<CostRecord> {
  const db = getDb()
  const [record] = await db
    .insert(costRecords)
    .values({ id: generateId(), ...input })
    .returning()
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
