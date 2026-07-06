import { api, API_BASE_URL, getToken } from './api'

type SseHandler = (payload: unknown) => void

const handlers = new Map<string, Set<SseHandler>>()
let es: EventSource | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let consecutiveFailures = 0
// After this many back-to-back connection failures, stop blindly reconnecting and
// probe an authed endpoint to find out WHY. EventSource.onerror can't see the HTTP
// status, so it can't tell "token expired" from "server briefly down" on its own.
const MAX_RECONNECT_FAILURES = 3

export function subscribeToEvent(type: string, handler: SseHandler): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set())
  handlers.get(type)!.add(handler)
  return () => handlers.get(type)?.delete(handler)
}

export function connectSse(): void {
  const token = getToken()
  if (!token) return
  // Skip if a socket already exists and hasn't fully closed — covers both OPEN and
  // CONNECTING, so a call made mid-handshake doesn't spawn a second, orphaned socket.
  if (es && es.readyState !== EventSource.CLOSED) return

  // EventSource doesn't support custom headers — pass token as query param
  es = new EventSource(`${API_BASE_URL}/events/stream?token=${encodeURIComponent(token)}`)

  es.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data as string) as { type: string; payload: unknown }
      const typedHandlers = handlers.get(type)
      if (typedHandlers) {
        for (const h of typedHandlers) h(payload)
      }
      // Also dispatch to '*' wildcard listeners
      const wildcardHandlers = handlers.get('*')
      if (wildcardHandlers) {
        for (const h of wildcardHandlers) h({ type, payload })
      }
    } catch {
      // ignore malformed events
    }
  }

  es.onopen = () => {
    reconnectDelay = 1000 // reset backoff on successful connect
    consecutiveFailures = 0
  }

  es.onerror = () => {
    es?.close()
    es = null
    consecutiveFailures++

    if (consecutiveFailures >= MAX_RECONNECT_FAILURES) {
      // Probe an authed endpoint to distinguish an expired token from a transient
      // outage. If the token is truly invalid, api.get's own 401 path runs
      // handleUnauthorized() (sign out + redirect). If it's just a network/server
      // blip (any non-401 failure) or the token is still good, keep reconnecting —
      // don't force a false logout on a brief drop / sleep-wake / server restart.
      consecutiveFailures = 0
      reconnectDelay = 1000
      void api
        .get('/auth/me')
        .then(() => scheduleReconnect())
        .catch(() => scheduleReconnect())
      return
    }

    scheduleReconnect()
  }
}

export function disconnectSse(): void {
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  reconnectTimeout = null
  es?.close()
  es = null
  reconnectDelay = 1000
  consecutiveFailures = 0
}

function scheduleReconnect(): void {
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  reconnectTimeout = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000) // cap at 30s
    connectSse()
  }, reconnectDelay)
}
