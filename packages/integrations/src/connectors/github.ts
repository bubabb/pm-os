import { BaseConnector, UnsupportedMutationError } from './base'
import { GitHubProjectsClient } from './github-projects'
import type {
  ConnectorCapabilities,
  FetchResult,
  MirrorBoardSnapshot,
  MutationEnvelope,
  MutationKind,
  MutationResult,
  NormalizedEntity,
  RemoteBoardOption,
  RemoteRef,
  ResourceOption,
} from '../types'

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

  // ── Write surface (bidirectional-sync.md §3.2) — Phase 1: card moves only ──

  override get capabilities(): ConnectorCapabilities {
    return { write: ['move_item'] as MutationKind[] }
  }

  override async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    const { op } = envelope
    if (op.kind !== 'move_item') {
      throw new UnsupportedMutationError(this.source, op.kind)
    }
    if (!op.ref.containerId || !op.statusFieldRemoteId) {
      throw new Error(`move_item op ${envelope.opId} is missing containerId or statusFieldRemoteId`)
    }
    const client = new GitHubProjectsClient(this.config.token)
    const { updatedAt } = await client.moveItem(
      op.ref.containerId,
      op.ref.remoteId,
      op.statusFieldRemoteId,
      op.toStatusRemoteId,
    )
    return { ref: op.ref, remoteVersion: updatedAt, raw: { updatedAt } }
  }

  override async fetchRemoteVersion(ref: RemoteRef): Promise<string | null> {
    return new GitHubProjectsClient(this.config.token).fetchItemVersion(ref.remoteId)
  }

  // Classic PATs report granted scopes in the x-oauth-scopes response header;
  // fine-grained PATs omit it entirely → 'unknown' (badge shows "untested").
  override async verifyWriteAccess(): Promise<'read_write' | 'read_only' | 'unknown'> {
    const res = await this.fetchWithRetry(`${BASE}/user`, { headers: this.headers })
    if (!res.ok) return 'unknown'
    const scopeHeader = res.headers.get('x-oauth-scopes')
    if (scopeHeader === null) return 'unknown'
    const scopes = scopeHeader.split(',').map((s) => s.trim())
    // 'project' = read/write on Projects v2; 'read:project' is read-only
    return scopes.includes('project') ? 'read_write' : 'read_only'
  }

  // ProjectV2 boards this token can see — powers the "Import remote board" picker
  override async listRemoteBoards(): Promise<RemoteBoardOption[]> {
    return new GitHubProjectsClient(this.config.token).listProjects()
  }

  // Full ProjectV2 snapshot — the pull side of the board mirror (mirror-sync
  // reaches GitHub exclusively through this method, never via the client).
  override async fetchBoardSnapshot(remoteBoardId: string): Promise<MirrorBoardSnapshot> {
    return new GitHubProjectsClient(this.config.token).fetchProjectSnapshot(remoteBoardId)
  }

  // All repos the token can access — owned, private, and invited/collaborator
  override async listResources(): Promise<ResourceOption[]> {
    const PER_PAGE = 100
    const options: ResourceOption[] = []

    for (let page = 1; page <= 2; page++) {
      const res = await this.fetchWithRetry(
        `${BASE}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${PER_PAGE}&sort=updated&page=${page}`,
        { headers: this.headers },
      )
      if (!res.ok) break

      const repos = await res.json() as GhRepo[]
      if (!Array.isArray(repos)) break
      for (const r of repos) {
        options.push({
          id: r.full_name,
          label: r.full_name,
          sublabel: r.private ? 'Private' : 'Public',
          metadata: { owner: r.owner.login, repo: r.name },
        })
      }
      if (repos.length < PER_PAGE) break
    }

    return options
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const { owner, repo } = this.repo
    if (!owner || !repo) return { entities: [], nextCursor: null }

    // Repo existence check — fetchWithRetry throws on 401/403 but returns 404,
    // so an unreadable repo (private/renamed/token lacks access) must be made
    // loud here instead of falling through as a silent empty success
    const repoRes = await this.fetchWithRetry(
      `${BASE}/repos/${owner}/${repo}`,
      { headers: this.headers },
    )
    if (repoRes.status === 404) {
      throw new Error(`GitHub repo ${owner}/${repo} not found, or your token lacks access (check the repo name, its visibility, and that the token has the "repo" scope).`)
    }

    const PER_PAGE = 50
    const page = cursor ? parseInt(cursor, 10) : 1
    const entities: NormalizedEntity[] = []
    let prCount = 0
    let issueCount = 0

    // Open pull requests
    const prsRes = await this.fetchWithRetry(
      `${BASE}/repos/${owner}/${repo}/pulls?state=open&per_page=${PER_PAGE}&page=${page}`,
      { headers: this.headers },
    )
    if (prsRes.ok) {
      const prs = await prsRes.json() as GhPr[]
      prCount = prs.length
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
            ticketIds,
          },
        })
      }
    }

    // Open issues (excludes PRs which GitHub also returns as issues)
    const issuesRes = await this.fetchWithRetry(
      `${BASE}/repos/${owner}/${repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`,
      { headers: this.headers },
    )
    if (issuesRes.ok) {
      const issues = await issuesRes.json() as GhIssue[]
      // Use raw response count for pagination — not filtered count.
      // A full page means more items may exist, regardless of how many are PRs.
      issueCount = issues.length
      for (const issue of issues) {
        if ('pull_request' in issue) continue
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

    // Advance if either list returned a full page — there may be more
    const nextCursor = (prCount === PER_PAGE || issueCount === PER_PAGE) ? String(page + 1) : null

    return { entities, nextCursor }
  }
}

interface GhRepo {
  name: string
  full_name: string
  private: boolean
  owner: { login: string }
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
