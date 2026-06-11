import { useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Plus,
  Search,
  Star,
} from 'lucide-react'
import { useProjectStore } from '../../store/projects'
import { Dialog } from '../../components/ui/Dialog'
import { Spinner } from '../../components/ui/Spinner'
import { toast } from '../../components/ui/Toast'
import { EmptyState } from '../../components/ui/EmptyState'
import { QueryError } from '../../components/ui/QueryError'
import { formatRelative } from '../../lib/format'

type Project = ReturnType<typeof useProjectStore.getState>['projects'][number]

// ── Templates ─────────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank Project',
    description: 'Empty project with no pre-created entities',
  },
  {
    id: 'ai-tool',
    name: 'New AI Tool Project',
    description: 'Pre-creates a board and agent workspace stub',
  },
  {
    id: 'agent-pipeline',
    name: 'New Agent Pipeline',
    description: 'Pre-creates a DAG with 3 placeholder nodes',
  },
] as const

// ── Deterministic avatar (color + emoji from project id) ─────────────────────
// Fixed literal class strings so Tailwind's scanner picks them up.

const AVATAR_COLORS = [
  'bg-emerald-500/20',
  'bg-sky-500/20',
  'bg-violet-500/20',
  'bg-amber-500/20',
  'bg-rose-500/20',
  'bg-teal-500/20',
  'bg-indigo-500/20',
  'bg-orange-500/20',
] as const

const AVATAR_EMOJIS = ['🚀', '🧠', '🛠️', '📦', '🔭', '⚙️', '🧪', '🗺️'] as const

function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

function avatarFor(id: string): { color: string; emoji: string } {
  const h = hashId(id)
  return {
    color: AVATAR_COLORS[h % AVATAR_COLORS.length] ?? 'bg-accent',
    emoji: AVATAR_EMOJIS[Math.floor(h / 8) % AVATAR_EMOJIS.length] ?? '📁',
  }
}

// ── Favorites (persisted in localStorage) ─────────────────────────────────────

const FAV_KEY = 'creare_fav_projects'

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

function saveFavorites(favorites: Set<string>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favorites]))
  } catch {
    // localStorage unavailable — favorites just won't persist
  }
}

function matchesQuery(p: Project, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return p.name.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ProjectList() {
  const {
    projects,
    archived,
    currentProject,
    isLoading,
    archivedLoading,
    error,
    load,
    loadArchived,
    setCurrentProject,
    createProject,
    archiveProject,
    unarchiveProject,
  } = useProjectStore()
  const navigate = useNavigate()
  const formId = useId()

  // Create dialog
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<string>('blank')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Archive confirm dialog
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null)
  const [archiving, setArchiving] = useState(false)

  // List UX
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites)
  const [showArchived, setShowArchived] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  useEffect(() => {
    void load()
    void loadArchived()
  }, [load, loadArchived])

  const visibleProjects = useMemo(() => {
    const filtered = projects.filter((p) => matchesQuery(p, query.trim()))
    // Stable sort: favorites float to the top, recency order preserved within groups
    return [...filtered].sort(
      (a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)),
    )
  }, [projects, query, favorites])

  function toggleFavorite(id: string) {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveFavorites(next)
      return next
    })
  }

  function openProject(p: Project) {
    setCurrentProject(p)
    navigate('/boards')
  }

  function openCreateDialog() {
    setNewName('')
    setNewDesc('')
    setSelectedTemplate('blank')
    setCreateError(null)
    setShowCreate(true)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      await createProject(name, newDesc.trim() || undefined, selectedTemplate)
      toast.success('Project created')
      setShowCreate(false)
      navigate('/boards')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project'
      setCreateError(message)
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }

  function onCreateSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void handleCreate()
  }

  async function handleArchiveConfirm() {
    if (!archiveTarget || archiving) return
    setArchiving(true)
    try {
      await archiveProject(archiveTarget.id)
      toast.success('Project archived')
      setArchiveTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive project')
    } finally {
      setArchiving(false)
    }
  }

  async function handleRestore(id: string) {
    if (restoringId) return
    setRestoringId(id)
    try {
      await unarchiveProject(id)
      toast.success('Project restored')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore project')
    } finally {
      setRestoringId(null)
    }
  }

  const showInitialSpinner = isLoading && projects.length === 0 && !error

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <button
          onClick={openCreateDialog}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New project
        </button>
      </div>

      {/* Loading / error / content */}
      {showInitialSpinner ? (
        <Spinner />
      ) : error ? (
        <QueryError message={error} onRetry={() => void load()} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No projects yet"
          description="Create your first project to start planning work and running agents."
          action={
            <button
              onClick={openCreateDialog}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New project
            </button>
          }
        />
      ) : (
        <>
          {/* Search */}
          <div className="relative mb-4">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter projects…"
              aria-label="Filter projects"
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary"
            />
          </div>

          {/* Active projects */}
          <div className="space-y-2">
            {visibleProjects.length === 0 && (
              <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                No projects match &ldquo;{query.trim()}&rdquo;
              </p>
            )}

            {visibleProjects.map((p) => {
              const { color, emoji } = avatarFor(p.id)
              const isCurrent = currentProject?.id === p.id
              const isFavorite = favorites.has(p.id)
              return (
                <div
                  key={p.id}
                  className={`group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:bg-accent/30 ${
                    isCurrent ? 'border-primary/50 bg-accent/20' : 'border-border bg-card'
                  }`}
                >
                  <button
                    onClick={() => openProject(p)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none focus:ring-2 focus:ring-primary rounded-md"
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base ${color}`}
                      aria-hidden="true"
                    >
                      {emoji}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {p.name}
                        </span>
                        {isCurrent && (
                          <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                            Current
                          </span>
                        )}
                      </span>
                      {p.description && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {p.description}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[11px] text-muted-foreground/60">
                        Updated {formatRelative(p.updatedAt ?? p.createdAt)}
                      </span>
                    </span>
                  </button>

                  <button
                    onClick={() => toggleFavorite(p.id)}
                    aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    aria-pressed={isFavorite}
                    className={`rounded-md p-1.5 transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary ${
                      isFavorite
                        ? 'text-amber-400'
                        : 'text-muted-foreground/50 hover:text-foreground'
                    }`}
                  >
                    <Star
                      className="h-4 w-4"
                      fill={isFavorite ? 'currentColor' : 'none'}
                      aria-hidden="true"
                    />
                  </button>

                  <button
                    onClick={() => setArchiveTarget(p)}
                    aria-label={`Archive ${p.name}`}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive focus:outline-none focus:ring-2 focus:ring-primary"
                  >
                    <Archive className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Archived section */}
      {!showInitialSpinner && !error && archived.length > 0 && (
        <div className="mt-8">
          <button
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary rounded-md px-1 py-0.5"
          >
            {showArchived ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Archived ({archived.length})
            {archivedLoading && <Spinner inline size="sm" />}
          </button>

          {showArchived && (
            <div className="mt-2 space-y-2">
              {archived.map((p) => {
                const { color, emoji } = avatarFor(p.id)
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 opacity-60"
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base grayscale ${color}`}
                      aria-hidden="true"
                    >
                      {emoji}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      {p.description && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {p.description}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => void handleRestore(p.id)}
                      disabled={restoringId !== null}
                      aria-label={`Restore ${p.name}`}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                    >
                      {restoringId === p.id ? (
                        <Spinner inline size="sm" />
                      ) : (
                        <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      Restore
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Create project dialog */}
      <Dialog
        open={showCreate}
        onClose={() => {
          if (!creating) setShowCreate(false)
        }}
        title="New project"
        footer={
          <>
            <button
              onClick={() => setShowCreate(false)}
              disabled={creating}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              disabled={!newName.trim() || creating}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              {creating && <Spinner inline size="sm" className="text-primary-foreground" />}
              {creating ? 'Creating…' : 'Create project'}
            </button>
          </>
        }
      >
        <form id={formId} onSubmit={onCreateSubmit} className="space-y-4">
          <div>
            <label
              htmlFor={`${formId}-name`}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Project name
            </label>
            <input
              id={`${formId}-name`}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="My AI Tool"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div>
            <label
              htmlFor={`${formId}-desc`}
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Description (optional)
            </label>
            <input
              id={`${formId}-desc`}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="What are you building?"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <fieldset>
            <legend className="mb-2 block text-xs font-medium text-muted-foreground">
              Template
            </legend>
            <div className="space-y-2">
              {TEMPLATES.map((t) => (
                <label
                  key={t.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    selectedTemplate === t.id
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border hover:bg-accent/30'
                  }`}
                >
                  <input
                    type="radio"
                    name="template"
                    value={t.id}
                    checked={selectedTemplate === t.id}
                    onChange={() => setSelectedTemplate(t.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{t.name}</span>
                    <span className="block text-xs text-muted-foreground">{t.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {createError && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {createError}
            </p>
          )}
        </form>
      </Dialog>

      {/* Archive confirmation dialog */}
      <Dialog
        open={archiveTarget !== null}
        onClose={() => {
          if (!archiving) setArchiveTarget(null)
        }}
        title="Archive project?"
        footer={
          <>
            <button
              onClick={() => setArchiveTarget(null)}
              disabled={archiving}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleArchiveConfirm()}
              disabled={archiving}
              className="flex items-center gap-2 rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              {archiving && <Spinner inline size="sm" className="text-destructive-foreground" />}
              {archiving ? 'Archiving…' : 'Archive'}
            </button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{archiveTarget?.name}</span> will be moved
          to the Archived section below the project list. You can restore it from there at any
          time.
        </p>
      </Dialog>
    </div>
  )
}
