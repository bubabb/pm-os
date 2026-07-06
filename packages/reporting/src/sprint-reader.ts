import { getDb, externalEventCache } from '@pm-os/database'
import { and, count, eq, isNull, gte, desc } from 'drizzle-orm'
import { getActiveSprint, listMilestones } from '@pm-os/boards'

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

  // Active sprint — via boards domain API
  const activeSprint = getActiveSprint(projectId)

  let sprintInfo: SprintContext['activeSprint'] = null
  if (activeSprint?.startDate && activeSprint?.endDate) {
    const start = new Date(activeSprint.startDate)
    const end   = new Date(activeSprint.endDate)
    const totalMs   = end.getTime() - start.getTime()
    const elapsedMs = now.getTime() - start.getTime()
    const totalDays = Math.max(1, Math.round(totalMs / 86_400_000))
    const dayNumber = Math.min(totalDays, Math.max(1, Math.ceil(elapsedMs / 86_400_000)))
    sprintInfo = { name: activeSprint.name, dayNumber, totalDays, endsAt: activeSprint.endDate }
  }

  // At-risk milestones — via boards domain API
  const cutoff = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  const allMilestones = listMilestones(projectId, { status: 'open' })
  const atRiskMilestones = allMilestones
    .filter((m) =>
      m.dueDate
        ? m.dueDate <= cutoff || m.status === 'at_risk' || m.status === 'missed'
        : m.status === 'at_risk' || m.status === 'missed',
    )
    .slice(0, 5)
    .map((m) => ({
      title: m.title,
      daysUntilDue: m.dueDate
        ? Math.round((new Date(m.dueDate).getTime() - now.getTime()) / 86_400_000)
        : 0,
      status: m.status,
    }))

  // Overnight delta — count of items fetched in last 24h (DB query is OK here — reading integrations cache)
  const since24h = new Date(now.getTime() - 86_400_000).toISOString()
  const [deltaRow] = await db
    .select({ total: count() })
    .from(externalEventCache)
    .where(
      and(
        eq(externalEventCache.projectId, projectId),
        isNull(externalEventCache.purgedAt),
        gte(externalEventCache.fetchedAt, since24h),
      ),
    )

  const overnightDelta = deltaRow?.total ?? 0

  // Last synced time
  const [lastRow] = await db
    .select({ fetchedAt: externalEventCache.fetchedAt })
    .from(externalEventCache)
    .where(and(eq(externalEventCache.projectId, projectId), isNull(externalEventCache.purgedAt)))
    .orderBy(desc(externalEventCache.fetchedAt))
    .limit(1)

  return {
    activeSprint: sprintInfo,
    atRiskMilestones,
    overnightDelta,
    lastSyncedAt: lastRow?.fetchedAt ?? null,
  }
}
