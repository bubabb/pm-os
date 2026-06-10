import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CalendarRange, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'
import { QueryError } from '../../components/ui/QueryError'

// ── Types ─────────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
type TaskType   = 'human' | 'agent'
type Priority   = 'low' | 'medium' | 'high' | 'critical'

interface Task {
  id: string
  projectId: string
  title: string
  type: TaskType
  status: TaskStatus
  priority: Priority
  startDate: string | null
  dueDate: string | null
  startedAt: string | null
  completedAt: string | null
}

interface TaskEdge {
  id: string
  projectId: string
  fromTaskId: string
  toTaskId: string
}

interface Sprint {
  id: string
  name: string
  status: string
  startDate: string | null
  endDate: string | null
}

interface Milestone {
  id: string
  title: string
  status: string
  dueDate: string | null
}

interface TimelineData {
  tasks: Task[]
  edges: TaskEdge[]
  sprints: Sprint[]
  milestones: Milestone[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_H = 36          // px per task row (left list and chart rows)
const HEADER_H = 48       // px for axis labels + milestone strip
const MIN_BAR_W = 12      // px so single-day tasks stay visible
const DAY_MS = 86_400_000
const EMPTY: never[] = [] // stable empty array so memo deps don't churn between renders

const STATUS_DOT: Record<TaskStatus, string> = {
  pending:          'bg-slate-400',
  in_progress:      'bg-blue-500',
  waiting_approval: 'bg-amber-500',
  completed:        'bg-emerald-500',
  failed:           'bg-red-500',
  cancelled:        'bg-zinc-300',
}

const STATUS_BAR: Record<TaskStatus, string> = {
  pending:          'bg-slate-400/80',
  in_progress:      'bg-blue-500',
  waiting_approval: 'bg-slate-400/80',
  completed:        'bg-emerald-500',
  failed:           'bg-red-500',
  cancelled:        'bg-muted-foreground/30',
}

const MILESTONE_DIAMOND: Record<string, string> = {
  completed: 'bg-emerald-500',
  at_risk:   'bg-amber-500',
  missed:    'bg-red-500',
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Parse 'YYYY-MM-DD' (or full ISO) to a local-midnight ms timestamp. */
function dateMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime()
}

function tickLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Transitive ancestors + descendants of a task over the edge list (BFS both ways). */
function dependencyChain(taskId: string, edges: TaskEdge[]): Set<string> {
  const visible = new Set<string>([taskId])
  // walk upward (ancestors): edges where toTaskId is in the frontier
  let queue = [taskId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of edges) {
      if (e.toTaskId === cur && !visible.has(e.fromTaskId)) {
        visible.add(e.fromTaskId)
        queue.push(e.fromTaskId)
      }
    }
  }
  // walk downward (descendants): edges where fromTaskId is in the frontier
  const seen = new Set<string>([taskId])
  queue = [taskId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of edges) {
      if (e.fromTaskId === cur && !seen.has(e.toTaskId)) {
        seen.add(e.toTaskId)
        visible.add(e.toTaskId)
        queue.push(e.toTaskId)
      }
    }
  }
  return visible
}

// ── Component ─────────────────────────────────────────────────────────────────

type DateField = 'startDate' | 'dueDate'

export function TimelineTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
  // Local drafts for in-progress date edits — committed on blur/Enter, not per keystroke
  const [drafts, setDrafts] = useState<Record<string, { startDate?: string; dueDate?: string }>>({})
  const [patchError, setPatchError] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery<TimelineData>({
    queryKey: ['timeline', projectId],
    queryFn: () => api.get(`/projects/${projectId}/timeline`),
  })

  const patchDates = useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: { startDate?: string | null; dueDate?: string | null } }) =>
      api.patch(`/projects/${projectId}/tasks/${taskId}`, body),
    // Patch the one task in the cache instead of refetching the whole timeline
    onSuccess: (_data, { taskId, body }) => {
      qc.setQueryData<TimelineData>(['timeline', projectId], (old) =>
        old ? { ...old, tasks: old.tasks.map((t) => (t.id === taskId ? { ...t, ...body } : t)) } : old,
      )
      setPatchError(null)
    },
    onError: (e: Error) => setPatchError(`Couldn't save date change: ${e.message}`),
    onSettled: (_data, _error, { taskId, body }) =>
      clearDraft(taskId, body.startDate !== undefined ? 'startDate' : 'dueDate'),
  })

  function setDraft(taskId: string, field: DateField, value: string) {
    setDrafts((d) => {
      const cur = d[taskId] ?? {}
      return { ...d, [taskId]: field === 'startDate' ? { ...cur, startDate: value } : { ...cur, dueDate: value } }
    })
  }

  function clearDraft(taskId: string, field: DateField) {
    setDrafts((d) => {
      const cur = d[taskId]
      if (!cur || cur[field] === undefined) return d
      const rest = { ...cur }
      delete rest[field]
      const next = { ...d }
      if (Object.keys(rest).length > 0) next[taskId] = rest
      else delete next[taskId]
      return next
    })
  }

  function commitDraft(task: Task, field: DateField) {
    const draft = drafts[task.id]?.[field]
    if (draft === undefined) return
    const value = draft || null // empty string clears the date
    if (value === task[field]) {
      clearDraft(task.id, field)
      return
    }
    patchDates.mutate({
      taskId: task.id,
      body: field === 'startDate' ? { startDate: value } : { dueDate: value },
    })
  }

  const tasks      = data?.tasks ?? EMPTY
  const edges      = data?.edges ?? EMPTY
  const sprints    = data?.sprints ?? EMPTY
  const milestones = data?.milestones ?? EMPTY

  // Focus mode: restrict to the clicked task + its full dependency chain
  const focusTask = focusTaskId ? tasks.find((t) => t.id === focusTaskId) ?? null : null
  const { visibleTasks, visibleEdges } = useMemo(() => {
    const focused = focusTaskId ? tasks.find((t) => t.id === focusTaskId) : undefined
    if (!focused) return { visibleTasks: tasks, visibleEdges: edges }
    const ids = dependencyChain(focused.id, edges)
    return {
      visibleTasks: tasks.filter((t) => ids.has(t.id)),
      visibleEdges: edges.filter((e) => ids.has(e.fromTaskId) && ids.has(e.toTaskId)),
    }
  }, [tasks, edges, focusTaskId])
  // Sprint bands / milestone markers only clutter a single dependency chain
  const visibleSprints    = focusTask ? EMPTY : sprints
  const visibleMilestones = focusTask ? EMPTY : milestones

  // Row lookups, built once per visible set (reused by the dependency-arrow loop)
  const taskById = useMemo(() => new Map(visibleTasks.map((t) => [t.id, t])), [visibleTasks])
  const rowIndex = useMemo(() => new Map(visibleTasks.map((t, i) => [t.id, i])), [visibleTasks])

  // ── Time scale ──────────────────────────────────────────────────────────────
  const scale = useMemo(() => {
    const points: number[] = []
    for (const t of visibleTasks) {
      if (t.startDate) points.push(dateMs(t.startDate))
      if (t.dueDate) points.push(dateMs(t.dueDate))
    }
    for (const s of visibleSprints) {
      if (s.startDate && s.endDate) { points.push(dateMs(s.startDate)); points.push(dateMs(s.endDate)) }
    }
    for (const m of visibleMilestones) {
      if (m.dueDate) points.push(dateMs(m.dueDate))
    }
    if (points.length === 0) return null

    const rawMin = Math.min(...points)
    const rawMax = Math.max(...points)
    const spanDays = Math.max(1, Math.round((rawMax - rawMin) / DAY_MS))
    const padDays = Math.max(2, Math.ceil(spanDays * 0.05))
    const min = rawMin - padDays * DAY_MS
    const max = rawMax + (padDays + 1) * DAY_MS
    const totalDays = Math.round((max - min) / DAY_MS)
    // clamp px-per-day so short ranges stay readable and long ones stay scrollable
    const pxPerDay = Math.max(10, Math.min(48, Math.round(1100 / totalDays)))
    const width = totalDays * pxPerDay
    const xFor = (iso: string) => ((dateMs(iso) - min) / DAY_MS) * pxPerDay

    // ticks: days when short, weeks when long
    const stepDays = totalDays <= 21 ? 1 : 7
    const ticks: { x: number; label: string }[] = []
    for (let ms = min; ms <= max; ms += stepDays * DAY_MS) {
      ticks.push({ x: ((ms - min) / DAY_MS) * pxPerDay, label: tickLabel(ms) })
    }
    return { min, max, width, pxPerDay, xFor, ticks }
  }, [visibleTasks, visibleSprints, visibleMilestones])

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (isError) {
    return <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
  }

  const todayMs = dateMs(new Date().toISOString().slice(0, 10))
  const bodyH = visibleTasks.length * ROW_H

  // bar geometry per visible task (null when not fully dated)
  const barFor = (t: Task): { x: number; w: number } | null => {
    if (!scale || !t.startDate || !t.dueDate) return null
    const x = scale.xFor(t.startDate)
    // bar spans through the end of the due day
    const w = Math.max(scale.xFor(t.dueDate) + scale.pxPerDay - x, MIN_BAR_W)
    return { x, w }
  }

  return (
    <div className="space-y-4">
      {/* Heading / focus controls */}
      <div className="flex items-center justify-between">
        {focusTask ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFocusTaskId(null)}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to full timeline
            </button>
            <h2 className="text-sm font-medium text-foreground">
              Dependency chain · <span className="text-primary">{focusTask.title}</span>
            </h2>
          </div>
        ) : (
          <h2 className="text-sm font-medium text-foreground">Timeline ({tasks.length} tasks)</h2>
        )}
        <p className="text-[11px] text-muted-foreground">Click a task to see its dependency chain</p>
      </div>

      {patchError && <p className="text-xs text-destructive">{patchError}</p>}

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <CalendarRange className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-foreground">No tasks yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Create tasks in the Agents page to plan them here.</p>
        </div>
      ) : (
        <div className="flex overflow-hidden rounded-lg border border-border bg-card">
          {/* ── Left pane: task list with date inputs ── */}
          <div className="w-[26rem] shrink-0 border-r border-border">
            <div
              className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              style={{ height: HEADER_H }}
            >
              <span className="flex-1">Task</span>
              <span className="w-28">Start</span>
              <span className="w-28">Due</span>
            </div>
            {visibleTasks.map((t) => (
              <div
                key={t.id}
                onClick={() => setFocusTaskId(t.id)}
                title={`${t.title} · ${t.status} · ${t.priority}`}
                className={`flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 transition-colors hover:bg-accent/30 ${
                  focusTaskId === t.id ? 'bg-primary/5' : ''
                }`}
                style={{ height: ROW_H }}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
                <span className="flex-1 truncate text-xs font-medium text-foreground">{t.title}</span>
                <input
                  type="date"
                  aria-label={`Start date for ${t.title}`}
                  value={drafts[t.id]?.startDate ?? t.startDate ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(t.id, 'startDate', e.target.value)}
                  onBlur={() => commitDraft(t, 'startDate')}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
                <input
                  type="date"
                  aria-label={`Due date for ${t.title}`}
                  value={drafts[t.id]?.dueDate ?? t.dueDate ?? ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(t.id, 'dueDate', e.target.value)}
                  onBlur={() => commitDraft(t, 'dueDate')}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className="w-28 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            ))}
          </div>

          {/* ── Right pane: chart ── */}
          <div className="flex-1 overflow-x-auto">
            {!scale ? (
              <div
                className="flex items-center justify-center px-6 text-center"
                style={{ height: HEADER_H + bodyH }}
              >
                <p className="text-xs text-muted-foreground">
                  No scheduled items yet — set start/due dates on tasks to see them on the timeline.
                </p>
              </div>
            ) : (
              <div style={{ width: scale.width }}>
                {/* Header: axis ticks + milestone strip */}
                <div className="relative border-b border-border bg-muted/30" style={{ height: HEADER_H }}>
                  {scale.ticks.map((tick, i) => (
                    <div key={i} className="absolute top-0 h-full" style={{ left: tick.x }}>
                      <span className="absolute left-1 top-1 whitespace-nowrap text-[10px] text-muted-foreground">
                        {tick.label}
                      </span>
                      <div className="absolute bottom-0 left-0 h-2.5 border-l border-border" />
                    </div>
                  ))}
                  {/* Milestone diamonds */}
                  {visibleMilestones.map((m) => {
                    if (!m.dueDate) return null
                    return (
                      <div
                        key={m.id}
                        title={`${m.title} · due ${m.dueDate} · ${m.status}`}
                        className={`absolute h-2.5 w-2.5 rotate-45 cursor-default rounded-[2px] ${
                          MILESTONE_DIAMOND[m.status] ?? 'bg-muted-foreground/60'
                        }`}
                        style={{ left: scale.xFor(m.dueDate) - 5, bottom: 6 }}
                      />
                    )
                  })}
                </div>

                {/* Body */}
                <div className="relative" style={{ height: bodyH }}>
                  {/* Sprint bands */}
                  {visibleSprints.map((s) => {
                    if (!s.startDate || !s.endDate) return null
                    const x = scale.xFor(s.startDate)
                    const w = Math.max(scale.xFor(s.endDate) + scale.pxPerDay - x, MIN_BAR_W)
                    return (
                      <div
                        key={s.id}
                        title={`${s.name} · ${s.startDate} → ${s.endDate}`}
                        className="absolute top-0 h-full border-x border-primary/10 bg-primary/5"
                        style={{ left: x, width: w }}
                      >
                        <span className="absolute left-1 top-0.5 truncate text-[9px] text-muted-foreground/70" style={{ maxWidth: w - 8 }}>
                          {s.name}
                        </span>
                      </div>
                    )
                  })}

                  {/* Tick grid lines */}
                  {scale.ticks.map((tick, i) => (
                    <div key={i} className="absolute top-0 h-full border-l border-border/40" style={{ left: tick.x }} />
                  ))}

                  {/* Today line */}
                  {todayMs >= scale.min && todayMs <= scale.max && (
                    <div
                      className="absolute top-0 h-full border-l-2 border-primary/50"
                      style={{ left: ((todayMs - scale.min) / DAY_MS) * scale.pxPerDay }}
                      title="Today"
                    />
                  )}

                  {/* Task bars */}
                  {visibleTasks.map((t, i) => {
                    const bar = barFor(t)
                    if (!bar) return null
                    const atRisk =
                      t.dueDate !== null &&
                      dateMs(t.dueDate) < todayMs &&
                      t.status !== 'completed' &&
                      t.status !== 'cancelled'
                    return (
                      <div
                        key={t.id}
                        onClick={() => setFocusTaskId(t.id)}
                        title={`${t.title} · ${t.startDate} → ${t.dueDate} · ${t.status}${atRisk ? ' · OVERDUE' : ''}`}
                        className={`absolute flex cursor-pointer items-center overflow-hidden rounded-md px-1.5 ${STATUS_BAR[t.status]} ${
                          atRisk ? 'ring-2 ring-red-500' : ''
                        }`}
                        style={{ left: bar.x, width: bar.w, top: i * ROW_H + 8, height: ROW_H - 16 }}
                      >
                        {bar.w > 48 && (
                          <span className="truncate text-[10px] font-medium text-white">{t.title}</span>
                        )}
                      </div>
                    )
                  })}

                  {/* Dependency arrows (SVG overlay) */}
                  <svg
                    className="pointer-events-none absolute inset-0 text-muted-foreground/70"
                    width={scale.width}
                    height={bodyH}
                  >
                    <defs>
                      <marker
                        id="gantt-arrowhead"
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="5"
                        markerHeight="5"
                        orient="auto-start-reverse"
                      >
                        <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                      </marker>
                    </defs>
                    {visibleEdges.map((e) => {
                      const from = taskById.get(e.fromTaskId)
                      const to = taskById.get(e.toTaskId)
                      if (!from || !to) return null
                      const fromBar = barFor(from)
                      const toBar = barFor(to)
                      if (!fromBar || !toBar) return null
                      const x1 = fromBar.x + fromBar.w
                      const y1 = (rowIndex.get(from.id) ?? 0) * ROW_H + ROW_H / 2
                      const x2 = toBar.x
                      const y2 = (rowIndex.get(to.id) ?? 0) * ROW_H + ROW_H / 2
                      // elbow: out of the from-bar, vertical run, into the to-bar
                      const mx = x2 - x1 >= 20 ? x1 + (x2 - x1) / 2 : x1 + 10
                      const d =
                        x2 - x1 >= 20
                          ? `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`
                          : `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${(y1 + y2) / 2} L ${x2 - 10} ${(y1 + y2) / 2} L ${x2 - 10} ${y2} L ${x2} ${y2}`
                      return (
                        <path
                          key={e.id}
                          d={d}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.2}
                          markerEnd="url(#gantt-arrowhead)"
                        />
                      )
                    })}
                  </svg>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
