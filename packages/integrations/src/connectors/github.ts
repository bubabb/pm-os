import { BaseConnector } from './base'
import type { FetchResult, NormalizedEntity } from '../types'

const BASE = 'https://api.github.com'

// Extracts Jira-style ticket IDs (e.g. PROJ-89) from text for cross-source correlation
export function extractTicketIds(text: string): string[] {
  return [...text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1]!)
}

export class GitHubConnector extends BaseConnector {
  get source() { return 'github' as const }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }

  private get repo(): { owner: string; repo: string } {
    const meta = this.config.metadata as { owner?: string; repo?: string } | undefined
    return { owner: meta?.owner ?? '', repo: meta?.repo ?? '' }
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const { owner, repo } = this.repo
    if (!owner || !repo) return { entities: [], nextCursor: null }

    const page = cursor ? parseInt(cursor, 10) : 1
    const entities: NormalizedEntity[] = []

    // Open pull requests
    const prsRes = await this.fetchWithRetry(
      `${BASE}/repos/${owner}/${repo}/pulls?state=open&per_page=50&page=${page}`,
      { headers: this.headers },
    )
    if (prsRes.ok) {
      const prs = await prsRes.json() as GhPr[]
      for (const pr of prs) {
        const ticketIds = [
          ...extractTicketIds(pr.title),
          ...extractTicketIds(pr.head?.ref ?? ''),
        ]
        entities.push({
          source: 'github',
          entityType: 'pr',
          entityId: String(pr.number),
          entityUrl: pr.html_url,
          title: pr.title,
          status: pr.state,
          assignee: pr.assignee?.login ?? null,
          updatedAt: pr.updated_at,
          raw: {
            number: pr.number,
            isDraft: pr.draft,
            requestedReviewers: pr.requested_reviewers?.length ?? 0,
            branchName: pr.head?.ref,
            labels: pr.labels?.map((l: { name: string }) => l.name) ?? [],
            ticketIds,   // Jira IDs extracted for correlation
          },
        })
      }
    }

    // Open issues (excludes PRs which GitHub also returns as issues)
    const issuesRes = await this.fetchWithRetry(
      `${BASE}/repos/${owner}/${repo}/issues?state=open&per_page=50&page=${page}`,
      { headers: this.headers },
    )
    if (issuesRes.ok) {
      const issues = await issuesRes.json() as GhIssue[]
      for (const issue of issues) {
        if ('pull_request' in issue) continue // skip PRs returned by issues endpoint
        entities.push({
          source: 'github',
          entityType: 'issue',
          entityId: `issue-${issue.number}`,
          entityUrl: issue.html_url,
          title: issue.title,
          status: issue.state,
          assignee: issue.assignee?.login ?? null,
          updatedAt: issue.updated_at,
          raw: {
            number: issue.number,
            labels: issue.labels?.map((l) => (typeof l === 'string' ? l : l.name)) ?? [],
          },
        })
      }
    }

    // Single page for MVP — no next cursor
    return { entities, nextCursor: null }
  }
}

interface GhPr {
  number: number
  title: string
  html_url: string
  state: string
  draft: boolean
  updated_at: string
  assignee: { login: string } | null
  requested_reviewers: unknown[]
  head: { ref: string }
  labels: { name: string }[]
}

interface GhIssue {
  number: number
  title: string
  html_url: string
  state: string
  updated_at: string
  assignee: { login: string } | null
  labels: Array<string | { name: string }>
  pull_request?: unknown
}
