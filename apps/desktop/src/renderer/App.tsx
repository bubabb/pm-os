import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import AppShell from './layouts/AppShell'
import ProtectedRoute from './components/ProtectedRoute'
import SignIn from './pages/auth/SignIn'
import ProjectList from './pages/projects/ProjectList'
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
            <Route index element={<Navigate to="/boards" replace />} />
            <Route path="projects" element={<ProjectList />} />
            <Route path="boards"         element={<Placeholder title="Boards" />} />
            <Route path="agents"         element={<Placeholder title="Agents" />} />
            <Route path="tools"          element={<Placeholder title="Tool Registry" />} />
            <Route path="observability"  element={<Placeholder title="Observability" />} />
            <Route path="reports"        element={<Placeholder title="Reports" />} />
            <Route path="settings"       element={<Placeholder title="Settings" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
