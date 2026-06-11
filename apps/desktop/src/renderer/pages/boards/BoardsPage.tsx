import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  LayoutGrid, Plus, Loader2, Flag, Milestone as MilestoneIcon,
  ChevronDown, Trash2, Play, CheckCircle2, Calendar, Search, Github,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { api } from '../../lib/api'
import { TimelineTab } from './TimelineTab'
import { ImportRemoteBoardDialog } from './ImportRemoteBoardDialog'
import { MirrorStatusChip } from './MirrorStatusChip'
import { Badge, BADGE_VARIANT_CLASSES, type BadgeVariant } from '../../components/ui/Badge'
import { QueryError } from '../../components/ui/QueryError'
import { Field } from '../../components/ui/Field'
import { toast } from '../../components/ui/Toast'
import { Dialog } from '../../components/ui/Dialog'
import { Spinner } from '../../components/ui/Spinner'

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

type MilestoneStatus = 'pending' | 'at_risk' | 'completed' | 'missed'

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

// Minimal task shape consumed from GET /projects/:projectId/tasks
// (matches the Task interface owned by AgentsPage).
type TaskStatus = 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
type TaskType = 'human' | 'agent'

interface Task {
  id: string
  title: string
  status: TaskStatus
  type: TaskType
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TASK_STATUS_BADGE: Record<TaskStatus, { label: string; variant: BadgeVariant }> = {
  pending:          { label: 'Pending',           variant: 'neutral' },
  in_progress:      { label: 'In Progress',       variant: 'info' },
  waiting_approval: { label: 'Awaiting Approval', variant: 'warning' },
  completed:        { label: 'Completed',         variant: 'success' },
  failed:           { label: 'Failed',            variant: 'danger' },
  cancelled:        { label: 'Cancelled',         variant: 'neutral' },
}

const SPRINT_STATUS_BADGE: Record<SprintStatus, { label: string; variant: BadgeVariant }> = {
  planning:  { label: 'Planning', variant: 'neutral' },
  active:    { label: 'Active',   variant: 'success' },
  completed: { label: 'Done',     variant: 'info' },
}

const MILESTONE_STATUS_BADGE: Record<MilestoneStatus, { label: string; variant: BadgeVariant }> = {
  pending:   { label: 'Pending',   variant: 'neutral' },
  at_risk:   { label: 'At Risk',   variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  missed:    { label: 'Missed',    variant: 'danger' },
}

type PageTab = 'boards' | 'sprints' | 'milestones' | 'timeline'

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
          { id: 'timeline'   as PageTab, label: 'Timeline' },
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
        {tab === 'timeline'   && <TimelineTab projectId={currentProject.id} />}
      </div>
    </div>
  )
}

// ── Boards Tab ────────────────────────────────────────────────────────────────

function BoardsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<BoardType>('kanban')
  const [actionError, setActionError] = useState<string | null>(null)
  // Native HTML5 drag-and-drop state. State ref doubles as a fallback for
  // environments where dataTransfer reads are restricted before drop.
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null)
  // Column the "Add task" dialog is targeting (null = dialog closed).
  const [addTaskColumn, setAddTaskColumn] = useState<BoardColumn | null>(null)

  const {
    data: boardList = [], isLoading: boardsLoading,
    isError: boardsError, error: boardsErr, refetch: refetchBoards,
  } = useQuery<Board[]>({
    queryKey: ['boards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/boards`),
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
      api.post<Board>(`/projects/${projectId}/boards`, body),
    onSuccess: (board: Board) => {
      qc.invalidateQueries({ queryKey: ['boards', projectId] })
      setSelectedBoardId(board.id)
      setShowCreate(false)
      setNewName('')
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  const deleteBoard = useMutation({
    mutationFn: (boardId: string) =>
      api.delete(`/projects/${projectId}/boards/${boardId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['boards', projectId] })
      setSelectedBoardId(null)
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  const moveItem = useMutation({
    mutationFn: ({ itemId, columnId }: { itemId: string; columnId: string }) =>
      api.patch(`/projects/${projectId}/boards/${activeBoardId}/items/${itemId}`, { columnId }),
    onMutate: async ({ itemId, columnId }: { itemId: string; columnId: string }) => {
      // Optimistic update: jump the card to its new column immediately.
      await qc.cancelQueries({ queryKey: ['board-items', activeBoardId] })
      qc.setQueryData<BoardItem[]>(['board-items', activeBoardId], (old) =>
        old?.map((i) => (i.id === itemId ? { ...i, columnId } : i)),
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-items', activeBoardId] })
      setActionError(null)
    },
    onError: (e: Error) => {
      // Roll back the optimistic move by refetching the server state.
      qc.invalidateQueries({ queryKey: ['board-items', activeBoardId] })
      toast.error(`Failed to move item: ${e.message}`)
      setActionError(e.message)
    },
  })

  const removeItem = useMutation({
    mutationFn: (itemId: string) =>
      api.delete(`/projects/${projectId}/boards/${activeBoardId}/items/${itemId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-items', activeBoardId] })
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  if (boardsLoading) return <Spinner />
  if (boardsError) {
    return <QueryError message={boardsErr instanceof Error ? boardsErr.message : undefined} onRetry={() => refetchBoards()} />
  }

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position)

  function handleColumnDrop(e: React.DragEvent<HTMLDivElement>, columnId: string) {
    e.preventDefault()
    setDragOverColumnId(null)
    const transferred = e.dataTransfer.getData('text/plain')
    const itemId = transferred !== '' ? transferred : draggingItemId
    setDraggingItemId(null)
    if (!itemId) return
    const dragged = items.find((i) => i.id === itemId)
    if (!dragged || dragged.columnId === columnId) return
    moveItem.mutate({ itemId, columnId })
  }

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
          onClick={() => setShowImport(true)}
          aria-label="Import a board from GitHub"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Github className="h-4 w-4" aria-hidden="true" />
          Import from GitHub
        </button>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New board
        </button>
      </div>

      <ImportRemoteBoardDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        projectId={projectId}
        onImported={(boardId) => setSelectedBoardId(boardId)}
      />

      {showCreate && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (newName.trim()) createBoard.mutate({ name: newName.trim(), type: newType }) }}
          className="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <h3 className="text-sm font-medium text-foreground">Create board</h3>
          <Field id="board-name" label="Board name">
            <input
              id="board-name"
              autoFocus
              placeholder="e.g. Sprint 12"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
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

      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

      {boardList.length === 0 && !showCreate ? (
        <EmptyState
          icon={LayoutGrid}
          title="No boards yet"
          desc="Create your first board to start tracking work."
        />
      ) : activeBoardId ? (
        <>
          {/* Mirror status (self-hides for non-mirrored boards). Sync-status polls
              every 30s; pulls are manual via "Pull now" — no auto-pull on board
              activation, to avoid surprise mutations/conflicts mid-drag. */}
          <MirrorStatusChip projectId={projectId} boardId={activeBoardId} />

          {(colsLoading || itemsLoading) ? <Spinner /> : (
            <div className="overflow-x-auto">
              <div className="flex gap-3" style={{ minWidth: `${sortedColumns.length * 220}px` }}>
                {sortedColumns.map((col) => {
                  const colItems = items.filter((i) => i.columnId === col.id)
                  const overWip = col.wipLimit !== null && colItems.length > col.wipLimit
                  const isDropTarget = dragOverColumnId === col.id
                  return (
                    <div
                      key={col.id}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (dragOverColumnId !== col.id) setDragOverColumnId(col.id)
                      }}
                      onDragLeave={(e) => {
                        // Ignore dragLeave fired by moving over child elements.
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDragOverColumnId((id) => (id === col.id ? null : id))
                        }
                      }}
                      onDrop={(e) => handleColumnDrop(e, col.id)}
                      className={`flex w-52 shrink-0 flex-col rounded-lg border border-border bg-muted/30 transition-shadow ${
                        isDropTarget ? 'ring-2 ring-primary/50' : ''
                      }`}
                    >
                      <div className={`flex items-center justify-between rounded-t-lg px-3 py-2 ${col.isTerminal ? 'bg-emerald-500/10 border-b border-emerald-500/30' : 'bg-card border-b border-border'}`}>
                        <span className="text-xs font-semibold text-foreground">{col.name}</span>
                        <div className="flex items-center gap-1">
                          <span className={`text-[10px] font-medium ${overWip ? 'text-red-400' : 'text-muted-foreground'}`}>
                            {colItems.length}{col.wipLimit !== null ? `/${col.wipLimit}` : ''}
                          </span>
                          <button
                            onClick={() => setAddTaskColumn(col)}
                            title="Add task"
                            aria-label={`Add task to ${col.name}`}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <Plus className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 space-y-2 p-2">
                        {colItems.length === 0 ? (
                          <button
                            onClick={() => setAddTaskColumn(col)}
                            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-3 text-[11px] text-muted-foreground/60 transition-colors hover:border-primary/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          >
                            <Plus className="h-3 w-3" aria-hidden="true" />
                            Add task
                          </button>
                        ) : (
                          colItems.map((item) => (
                            <KanbanCard
                              key={item.id}
                              item={item}
                              columns={sortedColumns}
                              onMove={(colId) => moveItem.mutate({ itemId: item.id, columnId: colId })}
                              onRemove={() => removeItem.mutate(item.id)}
                              moving={moveItem.isPending}
                              dragging={draggingItemId === item.id}
                              onDragStart={() => setDraggingItemId(item.id)}
                              onDragEnd={() => {
                                setDraggingItemId(null)
                                setDragOverColumnId(null)
                              }}
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

          <AddTaskDialog
            open={addTaskColumn !== null}
            onClose={() => setAddTaskColumn(null)}
            projectId={projectId}
            boardId={activeBoardId}
            column={addTaskColumn}
            boardTaskIds={items.map((i) => i.taskId)}
          />
        </>
      ) : null}
    </div>
  )
}

// ── Add Task Dialog ───────────────────────────────────────────────────────────
// Lists the project's tasks that are not yet on the active board and adds the
// chosen one to the column the user clicked.

function AddTaskDialog({
  open, onClose, projectId, boardId, column, boardTaskIds,
}: {
  open: boolean
  onClose: () => void
  projectId: string
  boardId: string
  column: BoardColumn | null
  boardTaskIds: string[]
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  // Start each open with a clean search.
  useEffect(() => {
    if (open) setSearch('')
  }, [open])

  const { data: tasks = [], isLoading, isError, error, refetch } = useQuery<Task[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.get(`/projects/${projectId}/tasks`),
    enabled: open,
  })

  const addItem = useMutation({
    mutationFn: ({ taskId, columnId }: { taskId: string; columnId: string }) =>
      api.post(`/projects/${projectId}/boards/${boardId}/items`, { taskId, columnId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['board-items', boardId] })
      qc.invalidateQueries({ queryKey: ['tasks', projectId] })
      toast.success('Task added to board')
      onClose()
    },
    onError: (e: Error) => toast.error(`Failed to add task: ${e.message}`),
  })

  const onBoard = new Set(boardTaskIds)
  const available = tasks.filter((t) => !onBoard.has(t.id))
  const query = search.trim().toLowerCase()
  const filtered = query === '' ? available : available.filter((t) => t.title.toLowerCase().includes(query))

  return (
    <Dialog
      open={open && column !== null}
      onClose={onClose}
      title={`Add task to ${column?.name ?? 'column'}`}
      footer={
        <button
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Cancel
        </button>
      }
    >
      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
      ) : tasks.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-muted-foreground">No tasks yet — create one in the Agents tab.</p>
          <button
            onClick={() => { onClose(); navigate('/agents') }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Go to Agents
          </button>
        </div>
      ) : available.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          All tasks are already on this board.
        </p>
      ) : (
        <div className="space-y-3">
          {available.length > 5 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                autoFocus
                aria-label="Search tasks"
                placeholder="Search tasks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No tasks match “{search.trim()}”.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {filtered.map((t) => {
                const badge = TASK_STATUS_BADGE[t.status]
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => { if (column) addItem.mutate({ taskId: t.id, columnId: column.id }) }}
                      disabled={addItem.isPending}
                      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{t.title}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">{t.type}</span>
                      <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>
                      {addItem.isPending && addItem.variables?.taskId === t.id && (
                        <Spinner size="sm" inline />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  )
}

// ── Kanban Card ───────────────────────────────────────────────────────────────

function KanbanCard({
  item, columns, onMove, onRemove, moving, dragging, onDragStart, onDragEnd,
}: {
  item: BoardItem
  columns: BoardColumn[]
  onMove: (colId: string) => void
  onRemove: () => void
  moving: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div
      draggable
      onDragStart={(e: React.DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={`relative cursor-grab rounded-md border border-border bg-card p-2 shadow-sm active:cursor-grabbing ${
        dragging ? 'opacity-50 ring-1 ring-primary/50' : ''
      }`}
    >
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
          aria-label={`Remove ${item.taskTitle ?? 'item'} from board`}
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

  const { data: allSprints = [], isLoading, isError, error, refetch } = useQuery<Sprint[]>({
    queryKey: ['sprints', projectId],
    queryFn: () => api.get(`/projects/${projectId}/sprints`),
  })

  const [actionError, setActionError] = useState<string | null>(null)
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sprints', projectId] })
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  const completeSprint = useMutation({
    mutationFn: ({ boardId, sprintId }: { boardId: string; sprintId: string }) =>
      api.post(`/projects/${projectId}/boards/${boardId}/sprints/${sprintId}/complete`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sprints', projectId] })
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  const displayed = filter === 'all' ? allSprints : allSprints.filter((s) => s.status === filter)

  if (isLoading) return <Spinner />
  if (isError) {
    return <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    create.mutate({
      name: newName.trim(),
      ...(newGoal ? { goal: newGoal } : {}),
      ...(newStart ? { startDate: newStart } : {}),
      ...(newEnd ? { endDate: newEnd } : {}),
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
            <p className="text-xs text-amber-400">Create a board first before adding sprints.</p>
          )}
          <Field id="sprint-name" label="Sprint name">
            <input
              id="sprint-name"
              autoFocus
              placeholder="e.g. Sprint 12"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
          <Field id="sprint-goal" label="Goal (optional)">
            <input
              id="sprint-goal"
              placeholder="What should this sprint achieve?"
              value={newGoal}
              onChange={(e) => setNewGoal(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="sprint-start" className="mb-1 block text-[10px] text-muted-foreground">Start date</label>
              <input
                id="sprint-start"
                type="date"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label htmlFor="sprint-end" className="mb-1 block text-[10px] text-muted-foreground">End date</label>
              <input
                id="sprint-end"
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

      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

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
                      <Badge variant={badge.variant} className="shrink-0">{badge.label}</Badge>
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
  const [actionError, setActionError] = useState<string | null>(null)

  const { data: milestoneList = [], isLoading, isError, error, refetch } = useQuery<Milestone[]>({
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
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  const updateStatus = useMutation({
    mutationFn: ({ milestoneId, status }: { milestoneId: string; status: MilestoneStatus }) =>
      api.patch(`/projects/${projectId}/milestones/${milestoneId}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['milestones', projectId] })
      setEditingId(null)
      setActionError(null)
    },
    onError: (e: Error) => setActionError(e.message),
  })

  if (isLoading) return <Spinner />
  if (isError) {
    return <QueryError message={error instanceof Error ? error.message : undefined} onRetry={() => refetch()} />
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim()) return
    create.mutate({
      title: newTitle.trim(),
      ...(newDesc ? { description: newDesc } : {}),
      ...(newDue ? { dueDate: newDue } : {}),
    })
  }

  const STATUSES: MilestoneStatus[] = ['pending', 'at_risk', 'completed', 'missed']

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
          <Field id="milestone-title" label="Milestone title">
            <input
              id="milestone-title"
              autoFocus
              placeholder="e.g. v1.0 Launch"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
          <Field id="milestone-desc" label="Description (optional)">
            <textarea
              id="milestone-desc"
              placeholder="What does this milestone deliver?"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </Field>
          <div>
            <label htmlFor="milestone-due" className="mb-1 block text-[10px] text-muted-foreground">Due date (optional)</label>
            <input
              id="milestone-due"
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

      {actionError && <p className="text-xs text-destructive">{actionError}</p>}

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
                      <p className={`mt-1 flex items-center gap-1 text-[11px] ${isOverdue ? 'text-red-400 font-medium' : 'text-muted-foreground'}`}>
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
                                ? BADGE_VARIANT_CLASSES[MILESTONE_STATUS_BADGE[s].variant]
                                : 'bg-muted text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {MILESTONE_STATUS_BADGE[s].label}
                          </button>
                        ))}
                        <button onClick={() => setEditingId(null)}
                          aria-label="Close status editor"
                          className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
                        >✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditingId(m.id)}
                        aria-label={`Change status of ${m.title} (currently ${badge.label})`}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE_VARIANT_CLASSES[badge.variant]} hover:opacity-80`}
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
