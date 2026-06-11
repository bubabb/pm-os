import type { ConnectorConfig, FetchResult, IntegrationSource, ResourceOption } from '../types'

export abstract class BaseConnector {
  constructor(protected config: ConnectorConfig) {}

  abstract get source(): IntegrationSource
  abstract fetchEntities(cursor?: string): Promise<FetchResult>

  // Lists the resources (repos/projects/spaces/databases/folders) this
  // connection's token can access — powers the UI resource picker.
  // Default: no picker support; subclasses override.
  async listResources(): Promise<ResourceOption[]> {
    return []
  }

  protected async fetchWithRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
    let lastError: Error = new Error('Unknown fetch error')
    for (let i = 0; i < attempts; i++) {
      let res: Response
      try {
        res = await fetch(url, init)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        await sleep(500 * Math.pow(2, i))
        continue
      }
      // Auth failures are fatal — throw so the sync is marked as an error
      // instead of being treated as an empty successful fetch
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status} from ${url}`)
      }
      // Rate limits and server errors: retry with backoff, throw if exhausted
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${url}`)
        await sleep(500 * Math.pow(2, i))
        continue
      }
      // 404 is non-fatal — connectors treat !res.ok as "no data available"
      return res
    }
    throw lastError
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
