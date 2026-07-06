import { useEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Kanban, Bot, Wrench, Eye, BarChart3, Plug, BrainCircuit, FolderOpen,
  Check, ChevronDown, ChevronsUpDown, Command, Plus, Settings, User,
  ChevronsLeft, ChevronsRight,
} from 'lucide-react'
import { NotificationsBell, NotificationsPanel } from '../components/notifications/NotificationsPanel'
import { CommandPalette } from '../components/ui/CommandPalette'
import { useProjectStore } from '../store/projects'

const navItems = [
  { to: '/boards',      label: 'Boards',        icon: Kanban },
  { to: '/agents',      label: 'Agents',         icon: Bot },
  { to: '/tools',       label: 'Tools',          icon: Wrench },
  { to: '/observability', label: 'Observability', icon: Eye },
  { to: '/intelligence', label: 'Intelligence',   icon: BrainCircuit },
  { to: '/reports',     label: 'Reports',        icon: BarChart3 },
  { to: '/connections', label: 'Connections',    icon: Plug },
  { to: '/settings',    label: 'Settings',       icon: Settings },
]

/** Routes that can appear in the topbar breadcrumb (nav + non-sidebar pages). */
const pageLabels: { to: string; label: string }[] = [
  ...navItems.map(({ to, label }) => ({ to, label })),
  { to: '/projects', label: 'Projects' },
]

function initialOf(name: string | undefined): string {
  return name?.[0]?.toUpperCase() ?? '?'
}

export default function AppShell() {
  const { projects, currentProject, setCurrentProject } = useProjectStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  const filterInputRef = useRef<HTMLInputElement>(null)

  const currentPageLabel =
    pageLabels.find(
      ({ to }) => location.pathname === to || location.pathname.startsWith(`${to}/`),
    )?.label ?? 'Overview'

  // Switcher popover: reset + focus the filter on open, close on Escape
  useEffect(() => {
    if (!switcherOpen) return
    setProjectFilter('')
    requestAnimationFrame(() => filterInputRef.current?.focus())
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSwitcherOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [switcherOpen])

  const filteredProjects = useMemo(() => {
    const q = projectFilter.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, projectFilter])


  function openCommandPalette() {
    // CommandPalette listens for Cmd/Ctrl+K on document — replay that event.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Sidebar */}
      <aside
        className={`flex flex-col border-r border-border bg-card transition-all duration-200 ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        {/* Logo + collapse */}
        <div className="flex h-14 items-center justify-between border-b border-border px-3">
          {!collapsed && (
            <span className="text-base font-bold tracking-tight text-foreground">Pm.Os</span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Project switcher */}
        <div className="relative border-b border-border px-2 py-2">
          <button
            onClick={() => setSwitcherOpen((o) => !o)}
            aria-label="Switch project"
            aria-expanded={switcherOpen}
            aria-haspopup="listbox"
            {...(collapsed ? { title: currentProject?.name ?? 'Select project' } : {})}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-bold text-primary-foreground">
              {initialOf(currentProject?.name)}
            </div>
            {!collapsed && (
              <>
                <span className="flex-1 truncate text-left text-foreground">
                  {currentProject?.name ?? 'Select project'}
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </>
            )}
          </button>

          {switcherOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSwitcherOpen(false)} />
              <div
                className={`absolute z-20 w-60 rounded-lg border border-border bg-popover shadow-lg ${
                  collapsed ? 'left-16 top-2' : 'left-2 top-full mt-1'
                }`}
              >
                <div className="border-b border-border p-1.5">
                  <input
                    ref={filterInputRef}
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    placeholder="Find project…"
                    aria-label="Filter projects"
                    className="w-full rounded-md bg-transparent px-2 py-1.5 text-sm text-popover-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <ul role="listbox" aria-label="Projects" className="max-h-56 overflow-y-auto p-1.5">
                  {filteredProjects.length === 0 && (
                    <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                      No projects match
                    </li>
                  )}
                  {filteredProjects.map((p) => {
                    const isCurrent = p.id === currentProject?.id
                    return (
                      <li key={p.id} role="presentation">
                        <button
                          role="option"
                          aria-selected={isCurrent}
                          onClick={() => {
                            setCurrentProject(p)
                            setSwitcherOpen(false)
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-primary text-[9px] font-bold text-primary-foreground">
                            {initialOf(p.name)}
                          </span>
                          <span className="flex-1 truncate text-left">{p.name}</span>
                          {isCurrent && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="border-t border-border p-1.5">
                  <button
                    onClick={() => {
                      setSwitcherOpen(false)
                      navigate('/projects')
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    New project
                  </button>
                  <button
                    onClick={() => {
                      setSwitcherOpen(false)
                      navigate('/projects')
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    Manage projects
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              {...(collapsed ? { title: label } : {})}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* User menu */}
        <div className="relative border-t border-border px-2 py-2">
          <button
            onClick={() => setUserMenuOpen((o) => !o)}
            aria-label="Account menu"
            aria-expanded={userMenuOpen}
            {...(collapsed ? { title: 'Account' } : {})}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <User className="h-3.5 w-3.5" />
            </div>
            {!collapsed && (
              <>
                <span className="flex-1 truncate text-left text-xs">Account</span>
                <ChevronDown className="h-3 w-3" />
              </>
            )}
          </button>

          {userMenuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
              <div className={`absolute bottom-12 z-20 w-44 rounded-lg border border-border bg-popover shadow-lg ${collapsed ? 'left-16' : 'left-2'}`}>
                <NavLink
                  to="/settings"
                  className="flex items-center gap-2 px-3 py-2 text-sm text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </NavLink>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
          <div className="flex min-w-0 items-center gap-2" aria-label="Breadcrumb">
            <span className="truncate text-sm text-muted-foreground">
              {currentProject?.name ?? 'No project'}
            </span>
            <span className="text-sm text-muted-foreground/60" aria-hidden="true">/</span>
            <span className="truncate text-sm font-medium text-foreground">{currentPageLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={openCommandPalette}
              aria-label="Open command palette"
              title="Command palette (Cmd/Ctrl+K)"
              className="mr-1 flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Command className="h-3 w-3" aria-hidden="true" />
              K
            </button>
            <NotificationsBell />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      <NotificationsPanel />
    </div>
  )
}
