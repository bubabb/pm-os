import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Kanban, Bot, Wrench, Eye, BarChart3,
  ChevronDown, LogOut, Settings, ChevronsLeft, ChevronsRight,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { NotificationsBell, NotificationsPanel } from '../components/notifications/NotificationsPanel'
import { useProjectStore } from '../store/projects'

const navItems = [
  { to: '/boards',      label: 'Boards',        icon: Kanban },
  { to: '/agents',      label: 'Agents',         icon: Bot },
  { to: '/tools',       label: 'Tools',          icon: Wrench },
  { to: '/observability', label: 'Observability', icon: Eye },
  { to: '/reports',     label: 'Reports',        icon: BarChart3 },
]

export default function AppShell() {
  const { user, signOut } = useAuthStore()
  const { currentProject, projects } = useProjectStore()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  async function handleSignOut() {
    await signOut()
    navigate('/auth')
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
            <span className="text-base font-bold tracking-tight text-foreground">Creare</span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Project switcher */}
        <div className="border-b border-border px-2 py-2">
          <NavLink
            to="/projects"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            {!collapsed && (
              <span className="truncate">{currentProject?.name ?? 'Select project'}</span>
            )}
          </NavLink>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
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
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </div>
            {!collapsed && (
              <>
                <span className="flex-1 truncate text-left text-xs">{user?.name}</span>
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
                  className="flex items-center gap-2 px-3 py-2 text-sm text-popover-foreground transition-colors hover:bg-accent"
                  onClick={() => setUserMenuOpen(false)}
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </NavLink>
                <button
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-popover-foreground transition-colors hover:bg-accent"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {currentProject?.name ?? 'No project selected'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <NotificationsBell />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <NotificationsPanel />
    </div>
  )
}
