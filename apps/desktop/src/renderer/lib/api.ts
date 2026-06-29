// When the UI is served over HTTP (the headless "Creare Server" web runtime),
// talk to the same origin it was loaded from — so the port is whatever the
// server used, not a hardcoded 4321. Under Electron the renderer loads from
// file://, which has no usable origin, so fall back to the local API port.
export const API_BASE_URL =
  typeof window !== 'undefined' && window.location.protocol.startsWith('http')
    ? window.location.origin
    : 'http://localhost:4321'
const BASE_URL = API_BASE_URL
const TOKEN_KEY = 'creare_auth_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers })

  if (response.status === 401) {
    clearToken()
    window.location.hash = '/auth'
    throw new ApiError(401, 'Unauthorized')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    // Prefer the human-readable `message` (Fastify puts actionable errors there, e.g. an
    // unreadable credential), then a route's `{ error }`, then the bare status text.
    const { message, error } = body as { message?: string; error?: string }
    throw new ApiError(response.status, message ?? error ?? response.statusText)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
