import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Archive, FolderOpen } from 'lucide-react'
import { useProjectStore } from '../../store/projects'

const TEMPLATES = [
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
  {
    id: 'blank',
    name: 'Blank Project',
    description: 'Empty project with no pre-created entities',
  },
]

export default function ProjectList() {
  const { projects, currentProject, load, setCurrentProject, createProject, archiveProject } =
    useProjectStore()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('blank')
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { load().catch(() => {}) }, [load])

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const project = await createProject(newName.trim(), newDesc.trim() || undefined)
      setShowCreate(false)
      setNewName('')
      setNewDesc('')
      setCurrentProject(project)
      navigate('/')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New project
        </button>
      </div>

      {/* Project list */}
      <div className="space-y-2">
        {projects.length === 0 && (
          <div className="rounded-xl border border-dashed border-border py-12 text-center">
            <FolderOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No projects yet — create one to get started</p>
          </div>
        )}

        {projects.map((p) => (
          <div
            key={p.id}
            className={`flex items-center justify-between rounded-lg border px-4 py-3 transition-colors hover:bg-accent/30 ${
              currentProject?.id === p.id ? 'border-primary/40 bg-accent/20' : 'border-border bg-card'
            }`}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => { setCurrentProject(p); navigate('/') }}
            >
              <p className="truncate text-sm font-medium text-card-foreground">{p.name}</p>
              {p.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.description}</p>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                Created {new Date(p.createdAt).toLocaleDateString()}
              </p>
            </button>

            <button
              onClick={() => setArchiveConfirm(p.id)}
              className="ml-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              aria-label="Archive project"
            >
              <Archive className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Create project dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            <h2 className="mb-4 text-base font-semibold text-card-foreground">New project</h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Project name
                </label>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  placeholder="My AI Tool"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Description (optional)
                </label>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="What are you building?"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none ring-offset-background focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  Template
                </label>
                <div className="space-y-2">
                  {TEMPLATES.map((t) => (
                    <label
                      key={t.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                        selectedTemplate === t.id
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border hover:border-border/80 hover:bg-accent/30'
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
                      <div>
                        <p className="text-sm font-medium text-card-foreground">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Archive confirmation dialog */}
      {archiveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xl">
            <h2 className="mb-2 text-base font-semibold text-card-foreground">Archive project?</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              This project will be archived and hidden from the project list. You can restore it
              later.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setArchiveConfirm(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await archiveProject(archiveConfirm)
                  setArchiveConfirm(null)
                }}
                className="rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
