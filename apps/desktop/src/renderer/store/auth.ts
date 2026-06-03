import { create } from 'zustand'
import { api, setToken, clearToken } from '../lib/api'
import { connectSse, disconnectSse } from '../lib/sse'

interface User {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: 'admin' | 'engineer' | 'pm' | 'viewer'
}

interface AuthState {
  user: User | null
  isLoading: boolean
  signIn: (provider: 'github' | 'entra') => Promise<void>
  signOut: () => Promise<void>
  loadCurrentUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: false,

  signIn: async (provider) => {
    set({ isLoading: true })
    try {
      // In Phase 1 the backend creates a dev user and returns a JWT.
      // Real OAuth browser flow ships in Phase 3.
      const result = await api.post<{ token: string; user: User }>('/auth/sign-in', { provider })
      setToken(result.token)
      set({ user: result.user, isLoading: false })
      connectSse()
    } catch (err) {
      set({ isLoading: false })
      throw err
    }
  },

  signOut: async () => {
    disconnectSse()
    clearToken()
    set({ user: null })
  },

  loadCurrentUser: async () => {
    set({ isLoading: true })
    try {
      const user = await api.get<User>('/auth/me')
      set({ user, isLoading: false })
      connectSse()
    } catch {
      set({ user: null, isLoading: false })
    }
  },
}))
