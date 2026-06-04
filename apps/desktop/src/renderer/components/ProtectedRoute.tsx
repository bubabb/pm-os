import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useProjectStore } from '../store/projects'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, loadCurrentUser } = useAuthStore()
  const { load: loadProjects } = useProjectStore()
  const navigate = useNavigate()
  const bootstrapped = useRef(false)

  useEffect(() => {
    // Guard: only run once per mount — prevents re-running on unrelated re-renders
    if (bootstrapped.current) return
    bootstrapped.current = true

    async function bootstrap() {
      // Step 1: restore session from localStorage token if user not already in store
      if (!useAuthStore.getState().user) {
        await loadCurrentUser()
        // loadCurrentUser() never throws — check store state after it resolves
        if (!useAuthStore.getState().user) {
          navigate('/auth')
          return
        }
      }

      // Step 2: load projects if not already fetched
      // Read directly from store to avoid stale closure values
      if (useProjectStore.getState().projects.length === 0) {
        useProjectStore.getState().load().catch(() => {})
      }
    }

    void bootstrap()
  }, []) // Empty deps — bootstrap runs exactly once per mount

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary" />
      </div>
    )
  }

  if (!user) return null
  return <>{children}</>
}
