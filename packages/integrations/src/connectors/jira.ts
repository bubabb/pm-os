import { BaseConnector } from './base'
import type { FetchResult, NormalizedEntity, ResourceOption } from '../types'

export class JiraConnector extends BaseConnector {
  get source() { return 'jira' as const }

  private get headers() {
    const meta = this.config.metadata as { email?: string } | undefined
    const email = meta?.email ?? ''
    // Jira Cloud: Basic auth with email + API token
    const encoded = Buffer.from(`${email}:${this.config.token}`).toString('base64')
    return {
      Authorization: `Basic ${encoded}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
  }

  // All Jira projects the token can access — powers the project picker
  override async listResources(): Promise<ResourceOption[]> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return []

    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/project/search?maxResults=100`,
      { headers: this.headers },
    )
    if (!res.ok) return []

    const data = await res.json() as JiraProjectSearchResult
    return (data.values ?? []).map((project) => ({
      id: project.key,
      label: project.name,
      sublabel: project.key,
      metadata: { projectKey: project.key },
    }))
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return { entities: [], nextCursor: null }

    const startAt = cursor ? parseInt(cursor, 10) : 0
    const maxResults = 50
    // Per-project resource scope: when a projectKey is set (source bound to a
    // global connection), constrain the JQL to that Jira project so data from
    // other projects on the same account never leaks in.
    const meta = this.config.metadata as { projectKey?: string } | undefined
    const projectKey = meta?.projectKey
    const baseJql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    const jql = encodeURIComponent(projectKey ? `project = ${projectKey} AND ${baseJql}` : baseJql)

    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,status,assignee,updated,labels,priority`,
      { headers: this.headers },
    )
    if (!res.ok) return { entities: [], nextCursor: null }

    const data = await res.json() as JiraSearchResult
    const entities: NormalizedEntity[] = data.issues.map((issue) => ({
      source: 'jira' as const,
      entityType: 'ticket',
      entityId: issue.key,
      entityUrl: `${baseUrl}/browse/${issue.key}`,
      title: issue.fields.summary,
      status: issue.fields.status?.name ?? null,
      assignee: issue.fields.assignee?.displayName ?? null,
      updatedAt: issue.fields.updated ?? null,
      raw: {
        key: issue.key,
        labels: issue.fields.labels ?? [],
        priority: issue.fields.priority?.name ?? null,
        statusCategory: issue.fields.status?.statusCategory?.name ?? null,
      },
    }))

    const fetched = startAt + data.issues.length
    const nextCursor = fetched < data.total ? String(fetched) : null

    return { entities, nextCursor }
  }
}

interface JiraProjectSearchResult {
  values?: Array<{ key: string; name: string }>
}

interface JiraSearchResult {
  total: number
  issues: JiraIssue[]
}

interface JiraIssue {
  key: string
  fields: {
    summary: string
    updated: string
    labels: string[]
    assignee: { displayName: string } | null
    status: { name: string; statusCategory: { name: string } } | null
    priority: { name: string } | null
  }
}
