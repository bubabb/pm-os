import { getDb, traces, agentWorkspaces, tasks } from '@creare/database'
import { eq, desc, inArray } from 'drizzle-orm'

export interface TraceStub {
  id: string
  taskTitle: string | null
  agentWorkspaceName: string
  status: string
  startedAt: string
  durationMs: number | null
  costCents: number
}

interface AgentActivity {
  running: TraceStub[]
  completedToday: TraceStub[]
  failed: TraceStub[]
}

export async function getAgentActivity(projectId: string): Promise<AgentActivity> {
  const db = getDb()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const rows = await db
    .select({
      id: traces.id,
      status: traces.status,
      startedAt: traces.startedAt,
      completedAt: traces.completedAt,
      durationMs: traces.durationMs,
      costCents: traces.costCents,
      taskId: traces.taskId,
      workspaceId: traces.agentWorkspaceId,
    })
    .from(traces)
    .where(eq(traces.projectId, projectId))
    .orderBy(desc(traces.startedAt))
    .limit(50)

  // Fetch workspace names and task titles in parallel
  const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))]
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean) as string[])]

  const [workspaceRows, taskRows] = await Promise.all([
    workspaceIds.length > 0
      ? db
          .select({ id: agentWorkspaces.id, name: agentWorkspaces.name })
          .from(agentWorkspaces)
          .where(inArray(agentWorkspaces.id, workspaceIds))
      : Promise.resolve([]),
    taskIds.length > 0
      ? db
          .select({ id: tasks.id, title: tasks.title })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
      : Promise.resolve([]),
  ])

  const workspaceMap = new Map(workspaceRows.map((w) => [w.id, w.name]))
  const taskMap = new Map(taskRows.map((t) => [t.id, t.title]))

  const toStub = (r: typeof rows[number]): TraceStub => ({
    id: r.id,
    taskTitle: r.taskId ? (taskMap.get(r.taskId) ?? null) : null,
    agentWorkspaceName: workspaceMap.get(r.workspaceId) ?? 'Unknown workspace',
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    costCents: r.costCents,
  })

  const running = rows.filter((r) => r.status === 'running').map(toStub)
  const completedToday = rows
    .filter((r) => r.status === 'completed' && r.startedAt >= todayStart.toISOString())
    .map(toStub)
  const failed = rows.filter((r) => r.status === 'failed').map(toStub)

  return { running, completedToday, failed }
}
