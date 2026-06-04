import { getDb, sprints, milestones, externalEventCache } from '@creare/database'
import { and, eq, gte, isNull, or } from 'drizzle-orm'

export interface SprintContext {
  activeSprint: {
    name: string
    dayNumber: number
    totalDays: number
    endsAt: string
  } | null
  atRiskMilestones: { title: string; daysUntilDue: number; status: string }[]
  overnightDelta: number
  lastSyncedAt: string | null
}

export async function getSprintContext(projectId: string): Promise<SprintContext> {
  const db = getDb()
  const now = new Date()

  // Active sprint
  const [activeSprint] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.projectId, projectId), eq(sprints.status, 'active')))
    .limit(1)

  let sprintInfo: SprintContext['activeSprint'] = null
  if (activeSprint?.startDate && activeSprint?.endDate) {
    const start = new Date(activeSprint.startDate)
    const end   = new Date(activeSprint.endDate)
    const totalMs = end.getTime() - start.getTime()
    const elapsedMs = now.getTime() - start.getTime()
    const totalDays   = Math.max(1, Math.round(totalMs / 86_400_000))
    const dayNumber   = Math.min(totalDays, Math.max(1, Math.ceil(elapsedMs / 86_400_000)))
    sprintInfo = { name: activeSprint.name, dayNumber, totalDays, endsAt: activeSprint.endDate }
  }

  // At-risk milestones — due within 14 days or already at_risk/missed
  const cutoff = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const atRiskRows = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.projectId, projectId),
        or(
          and(gte(milestones.dueDate, now.toISOString().slice(0, 10)), isNull(milestones.completedAt)),
          eq(milestones.status, 'at_risk'),
          eq(milestones.status, 'missed'),
        ),
      ),
    )
    .limit(5)

  const atRiskMilestones = atRiskRows
    .filter((m) => m.dueDate && (m.dueDate <= cutoff || m.status === 'at_risk' || m.status === 'missed'))
    .map((m) => {
      const daysUntilDue = m.dueDate
        ? Math.round((new Date(m.dueDate).getTime() - now.getTime()) / 86_400_000)
        : 0
      return { title: m.title, daysUntilDue, status: m.status }
    })

  // Overnight delta — items fetched in last 24h
  const since24h = new Date(now.getTime() - 86_400_000).toISOString()
  const [deltaRow] = await db
    .select({ id: externalEventCache.id })
    .from(externalEventCache)
    .where(
      and(
        eq(externalEventCache.projectId, projectId),
        isNull(externalEventCache.purgedAt),
        gte(externalEventCache.fetchedAt, since24h),
      ),
    )
    .limit(1)

  const overnightDelta = deltaRow ? 1 : 0  // rough indicator — use count in Phase 3

  // Last synced time — most recent fetchedAt across all active rows
  const [lastRow] = await db
    .select({ fetchedAt: externalEventCache.fetchedAt })
    .from(externalEventCache)
    .where(and(eq(externalEventCache.projectId, projectId), isNull(externalEventCache.purgedAt)))
    .orderBy(externalEventCache.fetchedAt)
    .limit(1)

  return {
    activeSprint: sprintInfo,
    atRiskMilestones,
    overnightDelta,
    lastSyncedAt: lastRow?.fetchedAt ?? null,
  }
}
