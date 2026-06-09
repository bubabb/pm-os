import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Plus, Loader2, CheckCircle2, XCircle, Clock,
  Play, Pause, StopCircle, ChevronDown, ChevronRight, ShieldAlert,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceStatus = 'idle' | 'running' | 'paused' | 'terminated'
type ModelProvider   = 'anthropic' | 'openai' | 'gemini' | 'local'

interface Workspace {
  id: string
  projectId: string
  name: string
  modelProvider: ModelProvider
  modelId: string
  status: WorkspaceStatus
  dailyTokenLimit: number | null
  dailyCostLimitCents: number | null
  tokensUsedToday: number
  costUsedTodayCents: number
  lastActiveAt: string | null
  createdAt: string
}

type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
type TaskType   = 'human' | 'agent'
type Priority   = 'low' | 'medium' | 'high' | 'critical'

interface Task {
  id: string
  title: string
  description: string | null
  type: TaskType
  status: TaskStatus
  priority: Priority
  agentWorkspaceId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

interface ApprovalGate {
  id: string
  taskId: string
  requestedBy: string
  reviewerId: string
  status: 'pending' | 'approved' | 'rejected'
  context: string
  reviewerNote: string | null
  resolvedAt: string | null
  createdAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL_PRESETS: { provider: ModelProvider; modelId: string; label: string }[] = [
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6' },
  { provider: 'anthropic', modelId: 'claude-opus-4-8',          label: 'Claude Opus 4.8' },
  { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { provider: 'openai',    modelId: 'gpt-4o',                    label: 'GPT-4o' },
  { provider: 'gemini',    modelId: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash' },
]

const PRIORITY_COLORS: Record<Priority, string> = {
  low:      'bg-zinc-100 text-zinc-600',
  medium:   'bg-blue-100 text-blue-700',
  high:     'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
}

const STATUS_BADGE: Record<TaskStatus, { label: string; cls: string }> = {
  pending:          { label: 'Pending',          cls: 'bg-zinc-100 text-zinc-600' },
  in_progress:      { label: 'In Progress',      cls: 'bg-blue-100 text-blue-700' },
  waiting_approval: { label: 'Awaiting Approval',cls: 'bg-amber-100 text-amber-700' },
  completed:        { label: 'Completed',         cls: 'bg-emerald-100 text-emerald-700' },
  failed:           { label: 'Failed',            cls: 'bg-red-100 text-red-700' },
  cancelled:        { label: 'Cancelled',         cls: 'bg-zinc-100 text-zinc-500' },
}

type PageTab = 'workspaces' | 'tasks' | 'gates'

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const { currentProject } = useProjectStore()
  const [tab, setTab] = useState<PageTab>('workspaces')

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view agents.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground">Agents</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Manage agent workspaces, task DAG, and approval gates for {currentProject.name}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border bg-card px-6">
        {([
          { id: 'workspaces' as PageTab, label: 'Workspaces' },
          { id: 'tasks'      as PageTab, label: 'Tasks' },
          { id: 'gates'      as PageTab, label: 'Approval Gates' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`border-b-2 px-4 py-2.5 text-sm transition-colors ${
              tab === id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'workspaces' && <WorkspacesTab projectId={currentProject.id} />}
        {tab === 'tasks'      && <TasksTab projectId={currentProject.id} />}
        {tab === 'gates'      && <ApprovalGatesTab projectId={currentProject.id} />}
      </div>
    </div>
  )
}

// ── Workspaces Tab ────────────────────────────────────────────────────────────

function WorkspacesTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(0)
  const [formError, setFormError] = useState<string | null>(null)

  const { data: workspaces = [], isLoading } = useQuery<Workspace[]>({
    queryKey: ['workspaces', projectId],
    queryFn: () => api.get(`/projects/${projectId}/workspaces`),
  })

  const create = useMutation({
    mutationFn: (body: { name: string; modelProvider: ModelProvider; modelId: string }) =>
      api.post(`/projects/${projectId}/workspaces`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces', projectId] })
      setShowCreate(false)
      setName('')
      setFormError(null)
    },
    onError: (e: Error) => setFormError(e.message),
  })

  const updateStatus = useMutation({
    mutationFn: ({ workspaceId, status }: { workspaceId: string; status: WorkspaceStatus }) =>
      api.patch(`/projects/${projectId}/workspaces/${workspaceId}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces', projectId] }),
  })

  const terminate = useMutation({
    mutationFn: (workspaceId: string) =>
      api.delete(`/projects/${projectId}/workspaces/${workspaceId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces', projectId] }),
  })

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setFormError('Name is required.'); return }
    const p = MODEL_PRESETS[preset]!
    create.mutate({ name: name.trim(), modelProvider: p.provider, modelId: p.modelId })
  }

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Agent Workspaces</h2>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New workspace
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium text-foreground">Create workspace</h3>
          <input
            autoFocus
            placeholder="Workspace name (e.g. Sprint Automation Agent)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="grid grid-cols-3 gap-2">
            {MODEL_PRESETS.map((p, i) => (
              <button
                key={p.modelId}
                type="button"
                onClick={() => setPreset(i)}
                className={`rounded-lg border px-2 py-2 text-xs transition-colors ${
                  preset === i
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      )}

      {workspaces.length === 0 && !showCreate ? (
        <EmptyState
          icon={Bot}
          title="No workspaces yet"
          desc="Create a workspace to start delegating tasks to agents."
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {workspaces.map((ws) => (
            <div key={ws.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  ws.status === 'running' ? 'bg-emerald-100' : 'bg-muted'
                }`}>
                  <Bot className={`h-4 w-4 ${ws.status === 'running' ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{ws.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {ws.modelId} · {ws.tokensUsedToday.toLocaleString()} tokens today
                    {ws.dailyTokenLimit ? ` / ${ws.dailyTokenLimit.toLocaleString()} limit` : ''}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <WorkspaceStatusBadge status={ws.status} />
                {ws.status === 'idle' && (
                  <IconBtn
                    title="Start"
                    onClick={() => updateStatus.mutate({ workspaceId: ws.id, status: 'running' })}
                    disabled={updateStatus.isPending}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </IconBtn>
                )}
                {ws.status === 'running' && (
                  <IconBtn
                    title="Pause"
                    onClick={() => updateStatus.mutate({ workspaceId: ws.id, status: 'paused' })}
                    disabled={updateStatus.isPending}
                  >
                    <Pause className="h-3.5 w-3.5" />
                  </IconBtn>
                )}
                {ws.status === 'paused' && (
                  <IconBtn
                    title="Resume"
                    onClick={() => updateStatus.mutate({ workspaceId: ws.id, status: 'running' })}
                    disabled={updateStatus.isPending}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </IconBtn>
                )}
                <IconBtn
                  title="Terminate"
                  onClick={() => terminate.mutate(ws.id)}
                  disabled={terminate.isPending}
                  danger
                >
                  <StopCircle className="h-3.5 w-3.5" />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tasks Tab ─────────────────────────────────────────────────────────────────

function TasksTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newType, setNewType] = useState<TaskType>('agent')
  const [newPriority, setNewPriority] = useState<Priority>('medium')

  const { data: allTasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.get(`/projects/${projectId}/tasks`),
  })

  const create = useMutation({
    mutationFn: (body: { title: string; description?: string; type: TaskType; priority: Priority }) =>
      api.post(`/projects/${projectId}/tasks`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      setShowCreate(false)
      setNewTitle('')
      setNewDesc('')
    },
  })

  const updateStatus = useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      api.patch(`/projects/${projectId}/tasks/${taskId}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  })

  const displayed = filter === 'all' ? allTasks : allTasks.filter((t) => t.status === filter)

  if (isLoading) return <Spinner />

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['all', 'pending', 'in_progress', 'waiting_approval', 'completed', 'failed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? 'All' : STATUS_BADGE[s].label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New task
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (newTitle.trim()) create.mutate({ title: newTitle.trim(), description: newDesc || undefined, type: newType, priority: newPriority }) }}
          className="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <h3 className="text-sm font-medium text-foreground">Create task</h3>
          <input
            autoFocus
            placeholder="Task title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <textarea
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-4">
            <div className="flex gap-1">
              {(['human', 'agent'] as TaskType[]).map((t) => (
                <button key={t} type="button" onClick={() => setNewType(t)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${newType === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex gap-1">
              {(['low', 'medium', 'high', 'critical'] as Priority[]).map((p) => (
                <button key={p} type="button" onClick={() => setNewPriority(p)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${newPriority === p ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowCreate(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >Cancel</button>
            <button type="submit" disabled={!newTitle.trim() || create.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      )}

      {displayed.length === 0 ? (
        <EmptyState icon={Clock} title="No tasks" desc="Create your first task or delegate from the PM Command Center." />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {displayed.map((task) => {
            const badge = STATUS_BADGE[task.status]
            const isExpanded = expanded === task.id
            return (
              <div key={task.id}>
                <div
                  className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/30"
                  onClick={() => setExpanded(isExpanded ? null : task.id)}
                >
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{task.title}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_COLORS[task.priority]}`}>
                        {task.priority}
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-muted text-muted-foreground capitalize">
                        {task.type}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {formatDate(task.createdAt)}
                      {task.startedAt && ` · Started ${formatDate(task.startedAt)}`}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>

                {isExpanded && (
                  <div className="border-t border-border/50 bg-muted/20 px-6 py-3 space-y-3">
                    {task.description && (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{task.description}</p>
                    )}
                    <div className="flex gap-2">
                      {task.status === 'pending' && (
                        <StatusBtn
                          label="Start"
                          onClick={() => updateStatus.mutate({ taskId: task.id, status: 'in_progress' })}
                          disabled={updateStatus.isPending}
                        />
                      )}
                      {task.status === 'in_progress' && (
                        <>
                          <StatusBtn label="Complete" onClick={() => updateStatus.mutate({ taskId: task.id, status: 'completed' })} disabled={updateStatus.isPending} />
                          <StatusBtn label="Fail" onClick={() => updateStatus.mutate({ taskId: task.id, status: 'failed' })} disabled={updateStatus.isPending} danger />
                        </>
                      )}
                      {(task.status === 'pending' || task.status === 'in_progress') && (
                        <StatusBtn label="Cancel" onClick={() => updateStatus.mutate({ taskId: task.id, status: 'cancelled' })} disabled={updateStatus.isPending} danger />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Approval Gates Tab ────────────────────────────────────────────────────────

function ApprovalGatesTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [notes, setNotes] = useState<Record<string, string>>({})

  const { data: gates = [], isLoading } = useQuery<ApprovalGate[]>({
    queryKey: ['approval-gates', projectId, 'pending'],
    queryFn: () => api.get(`/projects/${projectId}/approval-gates?status=pending`),
  })

  const resolve = useMutation({
    mutationFn: ({ gateId, resolution, reviewerNote }: { gateId: string; resolution: 'approved' | 'rejected'; reviewerNote?: string }) =>
      api.post(`/projects/${projectId}/approval-gates/${gateId}/resolve`, { resolution, reviewerNote }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approval-gates', projectId] }),
  })

  if (isLoading) return <Spinner />

  if (gates.length === 0) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No pending approvals"
        desc="Approval requests from agents will appear here."
      />
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-foreground">Pending Approval Gates ({gates.length})</h2>
      {gates.map((gate) => {
        let ctx: Record<string, unknown> = {}
        try { ctx = JSON.parse(gate.context) } catch { /* ignore */ }
        return (
          <div key={gate.id} className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">Approval Required</p>
                <p className="text-xs text-muted-foreground">Task ID: {gate.taskId} · Requested {formatDate(gate.createdAt)}</p>
              </div>
            </div>
            {Object.keys(ctx).length > 0 && (
              <pre className="rounded bg-background p-2 text-xs text-foreground overflow-auto max-h-24">
                {JSON.stringify(ctx, null, 2)}
              </pre>
            )}
            <textarea
              placeholder="Optional reviewer note…"
              value={notes[gate.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [gate.id]: e.target.value }))}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const note = notes[gate.id]
                  resolve.mutate({ gateId: gate.id, resolution: 'approved', ...(note ? { reviewerNote: note } : {}) })
                }}
                disabled={resolve.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" />
                Approve
              </button>
              <button
                onClick={() => {
                  const note = notes[gate.id]
                  resolve.mutate({ gateId: gate.id, resolution: 'rejected', ...(note ? { reviewerNote: note } : {}) })
                }}
                disabled={resolve.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/60 px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Shared components ─────────────────────────────────────────────────────────

function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  const cfg: Record<WorkspaceStatus, { label: string; cls: string }> = {
    idle:       { label: 'Idle',    cls: 'bg-zinc-100 text-zinc-600' },
    running:    { label: 'Running', cls: 'bg-emerald-100 text-emerald-700' },
    paused:     { label: 'Paused', cls: 'bg-amber-100 text-amber-700' },
    terminated: { label: 'Terminated', cls: 'bg-red-100 text-red-600' },
  }
  const { label, cls } = cfg[status]
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
}

function IconBtn({
  children, title, onClick, disabled, danger,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded p-1.5 transition-colors disabled:opacity-40 ${
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function StatusBtn({
  label, onClick, disabled, danger,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
        danger
          ? 'border border-destructive/60 text-destructive hover:bg-destructive/10'
          : 'border border-border text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )
}

function EmptyState({
  icon: Icon, title, desc,
}: {
  icon: React.ElementType
  title: string
  desc: string
}) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <Icon className="mx-auto mb-2 h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </div>
  )
}

function Spinner() {
  return (
    <div className="flex h-32 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
