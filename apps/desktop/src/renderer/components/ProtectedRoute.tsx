import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'
import { useProjectStore } from '../store/projects'
import { getToken } from '../lib/api'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, loadCurrentUser } = useAuthStore()
  const navigate = useNavigate()
  const bootstrapped = useRef(false)

  useEffect(() => {
    // Guard: only run once per mount — prevents re-running on unrelated re-renders
    if (bootstrapped.current) return
    bootstrapped.current = true

    async function bootstrap() {
      // Step 1: restore session from localStorage token if user not already in store
      if (!useAuthStore.getState().user) {
        // Only hit /auth/me when a token actually exists. With no token it 401s,
        // and the api client's global 401 handler hard-redirects to /auth before
        // the silent sign-in below can run.
        if (getToken()) {
          await loadCurrentUser()
        }
        // loadCurrentUser() never throws — check store state after it resolves
        if (!useAuthStore.getState().user) {
          // No session — silently auto sign-in a local user (dev-stub provider).
          // Only fall back to the /auth page if the silent sign-in fails.
          try {
            await useAuthStore.getState().signIn('github')
          } catch {
            navigate('/auth')
            return
          }
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
