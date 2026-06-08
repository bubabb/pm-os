import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  LayoutGrid, Plus, Loader2, Flag, Milestone as MilestoneIcon,
  ChevronDown, Trash2, Play, CheckCircle2, Calendar,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'

// ── Types ─────────────────────────────────────────────────────────────────────

type BoardType = 'kanban' | 'scrum'

interface Board {
  id: string
  projectId: string
  name: string
  type: BoardType
  createdAt: string
  updatedAt: string
}

interface BoardColumn {
  id: string
  boardId: string
  name: string
  position: number
  isTerminal: boolean
  wipLimit: number | null
  createdAt: string
  updatedAt: string
}

interface BoardItem {
  id: string
  boardId: string
  columnId: string
  taskId: string
  sprintId: string | null
  storyPoints: number | null
  position: number
  taskTitle: string | null
  createdAt: string
  updatedAt: string
}

type SprintStatus = 'planning' | 'active' | 'completed'

interface Sprint {
  id: string
  boardId: string
  projectId: string
  name: string
  goal: string | null
  status: SprintStatus
  startDate: string | null
  endDate: string | null
  velocity: number | null
  createdAt: string
  updatedAt: string
}

type MilestoneStatus = 'open' | 'in_progress' | 'completed' | 'at_risk'

interface Milestone {
  id: string
  projectId: string
  title: string
  description: string | null
  status: MilestoneStatus
  dueDate: string | null
  createdAt: string
  updatedAt: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SPRINT_STATUS_BADGE: Record<SprintStatus, { label: string; cls: string }> = {
  planning:  { label: 'Planning', cls: 'bg-zinc-100 text-zinc-600' },
  active:    { label: 'Active',   cls: 'bg-emerald-100 text-emerald-700' },
  completed: { label: 'Done',     cls: 'bg-blue-100 text-blue-700' },
}

const MILESTONE_STATUS_BADGE: Record<MilestoneStatus, { label: string; cls: string }> = {
  open:        { label: 'Open',        cls: 'bg-zinc-100 text-zinc-600' },
  in_progress: { label: 'In Progress', cls: 'bg-blue-100 text-blue-700' },
  at_risk:     { label: 'At Risk',     cls: 'bg-amber-100 text-amber-700' },
  completed:   { label: 'Completed',   cls: 'bg-emerald-100 text-emerald-700' },
}

type PageTab = 'boards' | 'sprints' | 'milestones'

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BoardsPage() {
  const { currentProject } = useProjectStore()
  const [tab, setTab] = useState<PageTab>('boards')

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Select a project to view boards.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold text-foreground">Boards</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Kanban boards, sprints, and milestones for {currentProject.name}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border bg-card px-6">
        {([
          { id: 'boards'     as PageTab, label: 'Boards' },
          { id: 'sprints'    as PageTab, label: 'Sprints' },
          { id: 'milestones' as PageTab, label: 'Milestones' },
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
        {tab === 'boards'     && <BoardsTab projectId={currentProject.id} />}
        {tab === 'sprints'    && <SprintsTab projectId={currentProject.id} />}
        {tab === 'milestones' && <MilestonesTab projectId={currentProject.id} />}
      </div>
    </div>
  )
}

// ── Boards Tab ────────────────────────────────────────────────────────────────

function BoardsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<BoardType>('kanban')

  const { data: boardList = [], isLoading: boardsLoading } = useQuery<Board[]>({
    queryKey: ['boards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/boards`),
    select: (data) => {
      if (!selectedBoardId && data.length > 0) {
        // Auto-select first board on initial load via side effect workaround — use index for render
      }
      return data
    },
  })

  const activeBoardId = selectedBoardId ?? boardList[0]?.id ?? null

  const { data: columns = [], isLoading: colsLoading } = useQuery<BoardColumn[]>({
    queryKey: ['board-columns', activeBoardId],
    queryFn: () => api.get(`/projects/${projectId}/boards/${activeBoardId}/columns`),
    enabled: activeBoardId !== null,
  })

  const { data: items = [], isLoading: itemsLoading } = useQuery<BoardItem[]>({
    queryKey: ['board-items', activeBoardId],
    queryFn: () => api.get(`/projects/${projectId}/boards/${activeBoardId}/items`),
    enabled: activeBoardId !== null,
  })

  const createBoard = useMutation({
    mutationFn: (body: { name: string; type: BoardType }) =>
      api.post(`/projects/${projectId}/boards`, body),
    onSuccess: (board: Board) => {
      qc.invalidateQueries({ queryKey: ['boards', projectId] })
      setSelectedBoardId(board.id)
      setShowCreate(false)
      setNewName('')
    },
  })

  const deleteBoard = useMutation({
    mutationFn: (boardId: string) =>
      api.delete(`/projects/${projectId}/boards/${boardId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boards', projectId] })
      setSelectedBoardId(null)
    },
  })

  const moveItem = useMutation({
    mutationFn: ({ itemId, columnId }: { itemId: string; columnId: string }) =>
      api.patch(`/projects/${projectId}/boards/${activeBoardId}/items/${itemId}`, { columnId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board-items', activeBoardId] }),
  })

  const removeItem = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/projects/${projectId}/boards/${activeBoardId}/items/${itemId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board-items', activeBoardId] }),
  })

  if (boardsLoading) return <Spinner />

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position)

  return (
    <div className="space-y-4">
      {/* Board selector row */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 flex-wrap gap-1">
          {boardList.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedBoardId(b.id)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                (activeBoardId === b.id)
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              {b.name}
              <span className="rounded px-1 py-0.5 text-[10px] bg-muted capitalize">{b.type}</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New board
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) createBoard.mutate({ name: newName.trim(), type: newType }) }}
          className="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <h3 className="text-sm font-medium text-foreground">Create board</h3>
          <input
            autoFocus
            placeholder="Board name (e.g. Sprint 12)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-2">
            {(['kanban', 'scrum'] as BoardType[]).map((t) => (
              <button key={t} type="button" onClick={() => setNewType(t)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${newType === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowCreate(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >Cancel</button>
            <button type="submit" disabled={!newName.trim() || createBoard.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createBoard.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      )}

      {boardList.length === 0 && !showCreate ? (
        <EmptyState
          icon={LayoutGrid}
          title="No boards yet"
          desc="Create your first board to start tracking work."
        />
      ) : activeBoardId ? (
        <>
          {(colsLoading || itemsLoading) ? <Spinner /> : (
            <div className="overflow-x-auto">
              <div className="flex gap-3" style={{ minWidth: `${sortedColumns.length * 220}px` }}>
                {sortedColumns.map((col) => {
                  const colItems = items.filter((i) => i.columnId === col.id)
                  const overWip = col.wipLimit !== null && colItems.length > col.wipLimit
                  return (
                    <div key={col.id} className="flex w-52 shrink-0 flex-col rounded-lg border border-border bg-muted/30">
                      <div className={`flex items-center justify-between rounded-t-lg px-3 py-2 ${col.isTerminal ? 'bg-emerald-50 border-b border-emerald-200' : 'bg-card border-b border-border'}`}>
                        <span className="text-xs font-semibold text-foreground">{col.name}</span>
                        <div className="flex items-center gap-1">
                          <span className={`text-[10px] font-medium ${overWip ? 'text-red-600' : 'text-muted-foreground'}`}>
                            {colItems.length}{col.wipLimit !== null ? `/${col.wipLimit}` : ''}
                          </span>
                        </div>
                      </div>
                      <div className="flex-1 space-y-2 p-2">
                        {colItems.length === 0 ? (
                          <p className="text-center text-[11px] text-muted-foreground/50 py-3">Empty</p>
                        ) : (
                          colItems.map((item) => (
                            <KanbanCard
                              key={item.id}
                              item={item}
                              columns={sortedColumns}
                              onMove={(colId) => moveItem.mutate({ itemId: item.id, columnId: colId })}
                              onRemove={() => removeItem.mutate(item.id)}
                              moving={moveItem.isPending}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Board actions */}
          <div className="flex justify-end">
            <button
              onClick={() => { if (confirm('Delete this board?')) deleteBoard.mutate(activeBoardId) }}
              disabled={deleteBoard.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-destructive/60 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete board
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

// ── Kanban Card ───────────────────────────────────────────────────────────────

function KanbanCard({
  item, columns, onMove, onRemove, moving,
}: {
  item: BoardItem
  columns: BoardColumn[]
  onMove: (colId: string) => void
  onRemove: () => void
  moving: boolean
}) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div className="relative rounded-md border border-border bg-card p-2 shadow-sm">
      <p className="text-xs font-medium text-foreground leading-snug">
        {item.taskTitle ?? item.taskId.slice(0, 8)}
      </p>
      {item.storyPoints !== null && (
        <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {item.storyPoints} pts
        </span>
      )}
      <div className="mt-2 flex items-center gap-1">
        <button
          onClick={() => setShowMenu((s) => !s)}
          disabled={moving}
          title="Move to column"
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          Move <ChevronDown className="h-2.5 w-2.5" />
        </button>
        <button
          onClick={onRemove}
          disabled={moving}
          title="Remove from board"
          className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {showMenu && (
        <div className="absolute left-0 top-full z-10 mt-0.5 w-40 rounded-lg border border-border bg-popover shadow-md">
          {columns.map((col) => (
            <button
              key={col.id}
              onClick={() => { onMove(col.id); setShowMenu(false) }}
              className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-accent first:rounded-t-lg last:rounded-b-lg"
            >
              {col.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sprints Tab ───────────────────────────────────────────────────────────────

function SprintsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<SprintStatus | 'all'>('all')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newGoal, setNewGoal] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')

  const { data: boards = [] } = useQuery<Board[]>({
    queryKey: ['boards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/boards`),
  })

  const { data: allSprints = [], isLoading } = useQuery<Sprint[]>({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get(`/projects/${projectId}/sprints`),
  })

  const defaultBoardId = boards[0]?.id

  const create = useMutation({
    mutationFn: (body: { name: string; goal?: string; startDate?: string; endDate?: string }) => {
      if (!defaultBoardId) throw new Error('Create a board first.')
      return api.post(`/projects/${projectId}/boards/${defaultBoardId}/sprints`, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sprints', projectId] })
      setShowCreate(false)
      setNewName('')
      setNewGoal('')
      setNewStart('')
      setNewEnd('')
    },
  })

  const startSprint = useMutation({
    mutationFn: ({ boardId, sprintId }: { boardId: string; sprintId: string }) =>
      api.post(`/projects/${projectId}/boards/${boardId}/sprints/${sprintId}/start`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sprints', projectId] }),
  })

  const completeSprint = useMutation({
    mutationFn: ({ boardId, sprintId }: { boardId: string; sprintId: string }) =>
      api.post(`/projects/${projectId}/boards/${boardId}/sprints/${sprintId}/complete`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sprints', projectId] }),
  })

  const displayed = filter === 'all' ? allSprints : allSprints.filter((s) => s.status === filter)

  if (isLoading) return <Spinner />

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    create.mutate({
      name: newName.trim(),
      goal: newGoal || undefined,
      startDate: newStart || undefined,
      endDate: newEnd || undefined,
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['all', 'planning', 'active', 'completed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                filter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'all' ? 'All' : SPRINT_STATUS_BADGE[s].label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New sprint
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium text-foreground">Create sprint</h3>
          {!defaultBoardId && (
            <p className="text-xs text-amber-600">Create a board first before adding sprints.</p>
          )}
          <input
            autoFocus
            placeholder="Sprint name (e.g. Sprint 12)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            placeholder="Goal (optional)"
            value={newGoal}
            onChange={(e) => setNewGoal(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">Start date</label>
              <input
                type="date"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">End date</label>
              <input
                type="date"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
          {create.error && <p className="text-xs text-destructive">{(create.error as Error).message}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowCreate(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
            >Cancel</button>
            <button type="submit" disabled={!newName.trim() || !defaultBoardId || create.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      )}

      {displayed.length === 0 ? (
        <EmptyState icon={Flag} title="No sprints" desc="Create your first sprint to organize work into time-boxed iterations." />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {displayed.map((sprint) => {
            const badge = SPRINT_STATUS_BADGE[sprint.status]
            return (
              <div key={sprint.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{sprint.name}</span>
                      <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                    </div>
                    {sprint.goal && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{sprint.goal}</p>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {sprint.startDate && (
                        <span className="flex items-center gap-0.5">
                          <Calendar className="h-3 w-3" />
                          {sprint.startDate}
                          {sprint.endDate ? ` → ${sprint.endDate}` : ''}
                        </span>
                      )}
                      {sprint.velocity !== null && (
                        <span>{sprint.velocity} pts velocity</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {sprint.status === 'planning' && (
                      <button
                        onClick={() => startSprint.mutate({ boardId: sprint.boardId, sprintId: sprint.id })}
                        disabled={startSprint.isPending}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        Start
                      </button>
                    )}
                    {sprint.status === 'active' && (
                      <button
                        onClick={() => completeSprint.mutate({ boardId: sprint.boardId, sprintId: sprint.id })}
                        disabled={completeSprint.isPending}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3 w-3" />
                        Complete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Milestones Tab ────────────────────────────────────────────────────────────

function MilestonesTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newDue, setNewDue] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const { data: milestoneList = [], isLoading } = useQuery<Milestone[]>({
    queryKey: ['milestones', projectId],
    queryFn: () => api.get(`/projects/${projectId}/milestones`),
  })

  const create = useMutation({
    mutationFn: (body: { title: string; description?: string; dueDate?: string }) =>
      api.post(`/projects/${projectId}/milestones`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['milestones', projectId] })
      setShowCreate(false)
      setNewTitle('')
      setNewDesc('')
      setNewDue('')
    },
  })

  const updateStatus = useMutation({
    mutationFn: ({ milestoneId, status }: { milestoneId: string; status: MilestoneStatus }) =>
      api.patch(`/projects/${projectId}/milestones/${milestoneId}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['milestones', projectId] })
      setEditingId(null)
    },
  })

  if (isLoading) return <Spinner />

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    create.mutate({
      title: newTitle.trim(),
      description: newDesc || undefined,
      dueDate: newDue || undefined,
    })
  }

  const STATUSES: MilestoneStatus[] = ['open', 'in_progress', 'at_risk', 'completed']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-foreground">Milestones ({milestoneList.length})</h2>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New milestone
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h3 className="text-sm font-medium text-foreground">Create milestone</h3>
          <input
            autoFocus
            placeholder="Milestone title (e.g. v1.0 Launch)"
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
          <div>
            <label className="mb-1 block text-[10px] text-muted-foreground">Due date (optional)</label>
            <input
              type="date"
              value={newDue}
              onChange={(e) => setNewDue(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
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

      {milestoneList.length === 0 && !showCreate ? (
        <EmptyState
          icon={MilestoneIcon}
          title="No milestones yet"
          desc="Create milestones to track major delivery goals and deadlines."
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {milestoneList.map((m) => {
            const badge = MILESTONE_STATUS_BADGE[m.status]
            const isOverdue = m.dueDate && m.status !== 'completed' && new Date(m.dueDate) < new Date()
            return (
              <div key={m.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <MilestoneIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">{m.title}</span>
                    </div>
                    {m.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.description}</p>
                    )}
                    {m.dueDate && (
                      <p className={`mt-1 flex items-center gap-1 text-[11px] ${isOverdue ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                        <Calendar className="h-3 w-3" />
                        Due {m.dueDate}
                        {isOverdue && ' · Overdue'}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {editingId === m.id ? (
                      <div className="flex gap-1">
                        {STATUSES.map((s) => (
                          <button
                            key={s}
                            onClick={() => updateStatus.mutate({ milestoneId: m.id, status: s })}
                            disabled={updateStatus.isPending}
                            className={`rounded px-2 py-1 text-[10px] font-medium capitalize transition-colors disabled:opacity-50 ${
                              m.status === s
                                ? MILESTONE_STATUS_BADGE[s].cls
                                : 'bg-muted text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {MILESTONE_STATUS_BADGE[s].label}
                          </button>
                        ))}
                        <button onClick={() => setEditingId(null)}
                          className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                        >✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingId(m.id)}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${badge.cls} hover:opacity-80`}
                      >
                        {badge.label}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

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
