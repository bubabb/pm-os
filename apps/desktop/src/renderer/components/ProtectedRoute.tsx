import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/auth'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, loadCurrentUser } = useAuthStore()
  const navigate = useNavigate()

  useEffect(() => {
    if (!user && !isLoading) {
      loadCurrentUser().catch(() => navigate('/auth'))
    }
  }, [user, isLoading, loadCurrentUser, navigate])

  useEffect(() => {
    if (!isLoading && !user) navigate('/auth')
  }, [user, isLoading, navigate])

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
