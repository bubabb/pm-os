import { getToken } from './api'

type SseHandler = (payload: unknown) => void

const handlers = new Map<string, Set<SseHandler>>()
let es: EventSource | null = null
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000

export function subscribeToEvent(type: string, handler: SseHandler): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set())
  handlers.get(type)!.add(handler)
  return () => handlers.get(type)?.delete(handler)
}

export function connectSse(): void {
  const token = getToken()
  if (!token) return
  if (es?.readyState === EventSource.OPEN) return

  // EventSource doesn't support custom headers — pass token as query param
  es = new EventSource(`http://localhost:4321/events/stream?token=${encodeURIComponent(token)}`)

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
  }

  es.onerror = () => {
    es?.close()
    es = null
    scheduleReconnect()
  }
}

export function disconnectSse(): void {
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  es?.close()
  es = null
}

function scheduleReconnect(): void {
  if (reconnectTimeout) clearTimeout(reconnectTimeout)
  reconnectTimeout = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000) // cap at 30s
    connectSse()
  }, reconnectDelay)
}
