import { getDb, notifications, projects } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, isNull, and, desc, count } from 'drizzle-orm'
import { emitEvent } from '../routes/events'
import type { Notification, AgentWorkspace, ApprovalGate } from '@creare/database'

export async function createNotification(input: {
  userId: string
  projectId?: string
  type: Notification['type']
  title: string
  body: string
  resourceType?: string
  resourceId?: string
}): Promise<Notification> {
  const db = getDb()
  const [notification] = await db
    .insert(notifications)
    .values({
      id: generateId(),
      userId: input.userId,
      projectId: input.projectId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
    })
    .returning()

  const n = notification!
  emitEvent(input.userId, { type: 'notification.new', payload: n })
  return n
}

export async function markAsRead(notificationId: string, userId: string): Promise<void> {
  const db = getDb()
  await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
}

export async function markAllAsRead(userId: string, projectId?: string): Promise<void> {
  const db = getDb()
  const conditions = [eq(notifications.userId, userId), isNull(notifications.readAt)]
  if (projectId) conditions.push(eq(notifications.projectId, projectId))
  await db.update(notifications).set({ readAt: new Date().toISOString() }).where(and(...conditions))
}

export async function getUnreadCount(userId: string): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
  return row?.total ?? 0
}

export async function listNotifications(userId: string, limit = 50): Promise<Notification[]> {
  const db = getDb()
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

// Called by agent-orchestration domain after every agent execution
export async function checkCostThreshold(workspace: AgentWorkspace): Promise<void> {
  const { dailyCostLimitCents, costUsedTodayCents } = workspace
  if (!dailyCostLimitCents || !costUsedTodayCents) return
  if (costUsedTodayCents < dailyCostLimitCents * 0.8) return

  const db = getDb()
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, workspace.projectId))
    .limit(1)
  if (!project) return

  const pct = Math.round((costUsedTodayCents / dailyCostLimitCents) * 100)
  await createNotification({
    userId: project.ownerId,
    projectId: workspace.projectId,
    type: 'cost_warning',
    title: 'Agent cost threshold reached',
    body: `Workspace "${workspace.name}" has used ${pct}% of its daily budget ($${(costUsedTodayCents / 100).toFixed(2)} of $${(dailyCostLimitCents / 100).toFixed(2)}).`,
    resourceType: 'agent_workspace',
    resourceId: workspace.id,
  })
}

// Called by agent-orchestration domain when an approval gate is created
export async function notifyApprovalNeeded(gate: ApprovalGate): Promise<void> {
  await createNotification({
    userId: gate.reviewerId,
    type: 'approval_needed',
    title: 'Agent action requires approval',
    body: 'An agent is waiting for your approval to proceed.',
    resourceType: 'approval_gate',
    resourceId: gate.id,
  })
}
