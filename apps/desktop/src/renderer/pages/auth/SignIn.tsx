import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/auth'

export default function SignIn() {
  const { signIn, isLoading } = useAuthStore()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn(provider: 'github' | 'entra') {
    setError(null)
    try {
      await signIn(provider)
      navigate('/')
    } catch {
      setError('Sign in failed. Make sure Creare is running.')
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-8 px-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Creare</h1>
          <p className="mt-2 text-sm text-muted-foreground">The agentic DevOps platform</p>
        </div>

        <div className="space-y-3">
          <button
            onClick={() => handleSignIn('github')}
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            Continue with GitHub
          </button>

          <button
            onClick={() => handleSignIn('entra')}
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            <svg viewBox="0 0 23 23" className="h-5 w-5">
              <rect x="1" y="1" width="10" height="10" fill="#f25022" />
              <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
              <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
              <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
            </svg>
            Continue with Microsoft
          </button>
        </div>

        {error && (
          <p className="text-center text-sm text-destructive">{error}</p>
        )}

        {isLoading && (
          <p className="text-center text-sm text-muted-foreground">Signing in…</p>
        )}
      </div>
    </div>
  )
}
