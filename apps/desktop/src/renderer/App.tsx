import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './layouts/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import SignIn from './pages/auth/SignIn'
import ProjectList from './pages/projects/ProjectList'
import PMCommandCenter from './pages/reports/PMCommandCenter'
import Settings from './pages/settings/Settings'
import AgentsPage from './pages/agents/AgentsPage'
import BoardsPage from './pages/boards/BoardsPage'
import Placeholder from './pages/Placeholder'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
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
            <Route path="tools"          element={<Placeholder title="Tool Registry" />} />
            <Route path="observability"  element={<Placeholder title="Observability" />} />
            <Route path="reports"        element={<PMCommandCenter />} />
            <Route path="settings"       element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
