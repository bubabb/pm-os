import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  BarChart3, Bot, BrainCircuit, Eye, FolderOpen, Kanban, Plug, Plus, Search, Settings, Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useProjectStore } from '../../store/projects'

// ── Command palette (Cmd/Ctrl+K) ──────────────────────────────────────────────
// Self-contained: registers its own global shortcut, renders nothing until
// opened. Commands: switch project, navigate, create project.

interface Command {
  id: string
  label: string
  /** Small right-aligned group hint ("Project", "Go to", …). */
  hint: string
  icon: LucideIcon
  run: () => void
}

// Mirrors the AppShell sidebar (plus Settings, which lives in the user menu).
const NAV_DESTINATIONS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/boards',        label: 'Boards',        icon: Kanban },
  { to: '/agents',        label: 'Agents',        icon: Bot },
  { to: '/tools',         label: 'Tools',         icon: Wrench },
  { to: '/observability', label: 'Observability', icon: Eye },
  { to: '/intelligence',  label: 'Intelligence',  icon: BrainCircuit },
  { to: '/reports',       label: 'Reports',       icon: BarChart3 },
  { to: '/connections',   label: 'Connections',   icon: Plug },
  { to: '/settings',      label: 'Settings',      icon: Settings },
]

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const projects = useProjectStore((s) => s.projects)
  const currentProject = useProjectStore((s) => s.currentProject)
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject)

  // Global shortcut: Cmd/Ctrl+K toggles, Escape closes
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Reset and focus on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlighted(0)
      // Focus after the portal renders
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const commands = useMemo<Command[]>(() => {
    function close() {
      setOpen(false)
    }
    const projectCommands: Command[] = projects
      .filter((p) => p.id !== currentProject?.id)
      .map((p) => ({
        id: `project-${p.id}`,
        label: `Switch to ${p.name}`,
        hint: 'Project',
        icon: FolderOpen,
        run: () => {
          setCurrentProject(p)
          close()
        },
      }))
    const navCommands: Command[] = NAV_DESTINATIONS.map(({ to, label, icon }) => ({
      id: `nav-${to}`,
      label: `Go to ${label}`,
      hint: 'Go to',
      icon,
      run: () => {
        navigate(to)
        close()
      },
    }))
    const createCommand: Command = {
      id: 'create-project',
      label: 'Create project',
      hint: 'Action',
      icon: Plus,
      run: () => {
        navigate('/projects')
        close()
      },
    }
    return [...projectCommands, ...navCommands, createCommand]
  }, [projects, currentProject, setCurrentProject, navigate])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  // Keep highlight valid as the filter changes
  useEffect(() => {
    setHighlighted(0)
  }, [query])

  // Keep the highlighted option visible while arrowing
  useEffect(() => {
    if (!open) return
    const active = filtered[highlighted]
    if (active) document.getElementById(`palette-option-${active.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, highlighted, filtered])

  if (!open) return null

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[highlighted]?.run()
    }
  }

  const activeCommand = filtered[highlighted]
  const activeId = activeCommand ? `palette-option-${activeCommand.id}` : undefined

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search projects, pages, actions…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            {...(activeId !== undefined && { 'aria-activedescendant': activeId })}
            className="w-full bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <ul id="palette-listbox" role="listbox" aria-label="Commands" className="max-h-72 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matching commands</li>
          )}
          {filtered.map((cmd, i) => {
            const Icon = cmd.icon
            const isActive = i === highlighted
            return (
              <li
                key={cmd.id}
                id={`palette-option-${cmd.id}`}
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => cmd.run()}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-accent text-accent-foreground' : 'text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 truncate">{cmd.label}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {cmd.hint}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
