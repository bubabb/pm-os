import type { ConnectorConfig, FetchResult, IntegrationSource } from '../types'

export abstract class BaseConnector {
  constructor(protected config: ConnectorConfig) {}

  abstract get source(): IntegrationSource
  abstract fetchEntities(cursor?: string): Promise<FetchResult>

  protected async fetchWithRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
    let lastError: Error = new Error('Unknown fetch error')
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url, init)
        // Non-fatal: no data available or forbidden — return empty
        if (res.status === 404 || res.status === 403) return res
        // Server errors: retry with backoff
        if (res.status >= 500) {
          lastError = new Error(`HTTP ${res.status} from ${url}`)
          await sleep(500 * Math.pow(2, i))
          continue
        }
        return res
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        await sleep(500 * Math.pow(2, i))
      }
    }
    throw lastError
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
