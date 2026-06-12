import { lazy, Suspense } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import AppShell from './layouts/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ToastViewport } from './components/ui/Toast'

// Code-split pages: each route loads its own chunk on first visit,
// trimming initial parse/init time and memory (shell stays eager).
const SignIn            = lazy(() => import('./pages/auth/SignIn'))
const ProjectList       = lazy(() => import('./pages/projects/ProjectList'))
const PMCommandCenter   = lazy(() => import('./pages/reports/PMCommandCenter'))
const Settings          = lazy(() => import('./pages/settings/Settings'))
const AgentsPage        = lazy(() => import('./pages/agents/AgentsPage'))
const BoardsPage        = lazy(() => import('./pages/boards/BoardsPage'))
const ObservabilityPage = lazy(() => import('./pages/observability/ObservabilityPage'))
const ToolsPage         = lazy(() => import('./pages/tools/ToolsPage'))
const ConnectionsPage   = lazy(() => import('./pages/connections/ConnectionsPage'))
const IntelligencePage  = lazy(() => import('./pages/intelligence/IntelligencePage'))

const queryClient = new QueryClient({
  // Desktop app: alt-tabbing back shouldn't refetch every query
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
})

function RouteFallback() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/auth" element={<SignIn />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/reports" replace />} />
              <Route path="projects" element={<ProjectList />} />
              <Route path="boards"         element={<BoardsPage />} />
              <Route path="agents"         element={<AgentsPage />} />
              <Route path="tools"          element={<ToolsPage />} />
              <Route path="observability"  element={<ObservabilityPage />} />
              <Route path="intelligence"   element={<IntelligencePage />} />
              <Route path="reports"        element={<PMCommandCenter />} />
              <Route path="connections"    element={<ConnectionsPage />} />
              <Route path="settings"       element={<Settings />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </HashRouter>
      {/* Global toast stack — mounted once so toast.* works app-wide */}
      <ToastViewport />
    </QueryClientProvider>
  )
}
