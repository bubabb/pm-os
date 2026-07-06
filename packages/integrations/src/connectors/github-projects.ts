import { stableHash } from '@creare/shared'
import type {
  MirrorBoardSnapshot,
  MirrorColumnSnapshot,
  MirrorItemSnapshot,
  RemoteBoardOption,
} from '../types'

// GitHub Projects v2 GraphQL client (docs/architecture/bidirectional-sync.md §3.3).
// Standalone (not a BaseConnector) — it is the low-level transport that
// GitHubConnector composes for its mirror read/write surface.

const GRAPHQL_URL = 'https://api.github.com/graphql'

// ── Error taxonomy ──────────────────────────────────────────────────────────
// GraphQL returns HTTP 200 with a top-level `errors[]` array for most failures,
// so HTTP status alone is NOT a health signal — classify errors[].type.

// Transient — the outbox worker retries these with backoff, honoring
// `retryAfterMs` when GitHub sent a Retry-After header.
export class GitHubRateLimitError extends Error {
  readonly retryable = true as const
  constructor(message: string, readonly retryAfterMs: number | null) {
    super(message)
    this.name = 'GitHubRateLimitError'
  }
}

// Fatal — the token lacks the `project` scope (or access is forbidden).
// Never retried; surfaces as a read-only banner + failed op.
export class GitHubScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubScopeError'
  }
}

// The referenced node does not exist or is invisible to this token.
export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubNotFoundError'
  }
}

interface GraphqlErrorEntry {
  type?: string
  message?: string
}

// ── Project URL parsing ─────────────────────────────────────────────────────
// Cross-owner import requires a full project URL — a bare number would be
// ambiguous (whose project #2?). Unparseable input → null, never a throw.

export interface ParsedProjectUrl {
  login: string
  number: number
  ownerType: 'user' | 'org'
}

/**
 * Parse a GitHub Projects v2 URL into its owner + number:
 *   https://github.com/users/<login>/projects/<n> → { login, number, ownerType: 'user' }
 *   https://github.com/orgs/<login>/projects/<n>  → { login, number, ownerType: 'org' }
 * Trailing path segments (e.g. /views/1) and query strings are tolerated.
 * Anything else (non-GitHub host, repo URLs, bare numbers) → null.
 */
export function parseProjectUrl(input: string): ParsedProjectUrl | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
  const match = /^\/(users|orgs)\/([^/]+)\/projects\/(\d+)(?:\/|$)/.exec(url.pathname)
  if (!match) return null
  const number = Number(match[3]!)
  if (!Number.isSafeInteger(number) || number <= 0) return null
  return {
    login: decodeURIComponent(match[2]!),
    number,
    ownerType: match[1] === 'users' ? 'user' : 'org',
  }
}

export class GitHubProjectsClient {
  constructor(private token: string) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const ATTEMPTS = 3
    let lastError: Error = new Error('Unknown GraphQL fetch error')

    for (let i = 0; i < ATTEMPTS; i++) {
      let res: Response
      try {
        res = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        await sleep(500 * Math.pow(2, i))
        continue
      }

      // HTTP-level classification (rare for GraphQL but possible)
      if (res.status === 401 || res.status === 403) {
        throw new GitHubScopeError(`GitHub GraphQL HTTP ${res.status} — token rejected or missing scopes`)
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = parseRetryAfter(res)
        lastError = new GitHubRateLimitError(`GitHub GraphQL HTTP ${res.status}`, retryAfterMs)
        await sleep(Math.min(retryAfterMs ?? 500 * Math.pow(2, i), 10_000))
        continue
      }
      if (!res.ok) {
        throw new Error(`GitHub GraphQL HTTP ${res.status}`)
      }

      const body = (await res.json()) as { data?: T | null; errors?: GraphqlErrorEntry[] }

      // CRITICAL: GraphQL signals most failures as HTTP 200 + errors[]
      if (body.errors && body.errors.length > 0) {
        const types = body.errors.map((e) => e.type ?? '')
        const message = body.errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ')
        if (types.includes('RATE_LIMITED')) {
          throw new GitHubRateLimitError(`GitHub GraphQL rate limited: ${message}`, parseRetryAfter(res))
        }
        if (types.includes('INSUFFICIENT_SCOPES') || types.includes('FORBIDDEN')) {
          throw new GitHubScopeError(`GitHub GraphQL scope error: ${message}`)
        }
        if (types.includes('NOT_FOUND')) {
          throw new GitHubNotFoundError(`GitHub GraphQL not found: ${message}`)
        }
        throw new Error(`GitHub GraphQL error: ${message}`)
      }

      if (body.data === undefined || body.data === null) {
        throw new Error('GitHub GraphQL: response had no data')
      }
      return body.data
    }

    throw lastError
  }

  // Projects the viewer can see — personal + each org's. Used by the
  // "Import remote board" picker. Cursor-paginated in every bucket (personal
  // projects, the org list, and each org's projects) so nothing is silently
  // truncated; MAX_PAGES is a runaway guard (10 × 100 per bucket), not an
  // expected limit. Cross-owner projects the viewer merely collaborates on
  // are NOT enumerable via the API — that path is resolveProject (import by
  // URL).
  async listProjects(): Promise<RemoteBoardOption[]> {
    const MAX_PAGES = 10
    const options: RemoteBoardOption[] = []
    const seen = new Set<string>()
    const push = (node: ProjectNode | null) => {
      if (!node || seen.has(node.id)) return
      seen.add(node.id)
      options.push({ id: node.id, label: node.title, sublabel: `#${node.number}`, url: node.url })
    }

    // Personal projects — page until exhausted
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: ViewerProjectsData = await this.graphql<ViewerProjectsData>(
        `query ViewerProjects($cursor: String) {
          viewer {
            projectsV2(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
              pageInfo { hasNextPage endCursor }
              nodes { id title number url }
            }
          }
        }`,
        { cursor },
      )
      const conn = data.viewer.projectsV2
      for (const node of conn.nodes ?? []) push(node)
      if (!conn.pageInfo.hasNextPage) break
      cursor = conn.pageInfo.endCursor
    }

    // Org projects — page the org list; orgs whose first 100 projects
    // overflow get follow-up paging below
    const overflow: Array<{ login: string; cursor: string | null }> = []
    let orgCursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: ViewerOrganizationsData = await this.graphql<ViewerOrganizationsData>(
        `query ViewerOrgProjects($orgCursor: String) {
          viewer {
            organizations(first: 25, after: $orgCursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                login
                projectsV2(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
                  pageInfo { hasNextPage endCursor }
                  nodes { id title number url }
                }
              }
            }
          }
        }`,
        { orgCursor },
      )
      const orgs = data.viewer.organizations
      for (const org of orgs.nodes ?? []) {
        if (!org) continue
        for (const node of org.projectsV2.nodes ?? []) push(node)
        if (org.projectsV2.pageInfo.hasNextPage) {
          overflow.push({ login: org.login, cursor: org.projectsV2.pageInfo.endCursor })
        }
      }
      if (!orgs.pageInfo.hasNextPage) break
      orgCursor = orgs.pageInfo.endCursor
    }

    // Follow-up paging for orgs with >100 projects
    for (const org of overflow) {
      let projectCursor: string | null = org.cursor
      for (let page = 0; page < MAX_PAGES && projectCursor !== null; page++) {
        const data: OrgProjectsData = await this.graphql<OrgProjectsData>(
          `query OrgProjects($login: String!, $cursor: String) {
            organization(login: $login) {
              projectsV2(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
                pageInfo { hasNextPage endCursor }
                nodes { id title number url }
              }
            }
          }`,
          { login: org.login, cursor: projectCursor },
        )
        const conn = data.organization?.projectsV2
        if (!conn) break
        for (const node of conn.nodes ?? []) push(node)
        projectCursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null
      }
    }

    return options
  }

  // Resolve one ProjectV2 by owner login + project number — the cross-owner
  // import path (listProjects only sees the viewer's own + org projects, but a
  // token can also access OTHER users'/orgs' projects it collaborates on).
  // Tries user(login) first, falls back to organization(login). "Not found /
  // not accessible" is a legitimate answer → null, never a throw; scope/auth/
  // rate-limit errors still propagate from graphql().
  async resolveProject(login: string, number: number): Promise<RemoteBoardOption | null> {
    const userData = await this.tryResolveQuery<ResolveUserProjectData>(
      `query ResolveUserProject($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) { id title number url }
        }
      }`,
      { login, number },
    )
    const userProject = userData?.user?.projectV2 ?? null
    if (userProject) return toBoardOption(userProject)

    const orgData = await this.tryResolveQuery<ResolveOrgProjectData>(
      `query ResolveOrgProject($login: String!, $number: Int!) {
        organization(login: $login) {
          projectV2(number: $number) { id title number url }
        }
      }`,
      { login, number },
    )
    const orgProject = orgData?.organization?.projectV2 ?? null
    return orgProject ? toBoardOption(orgProject) : null
  }

  // A NOT_FOUND from graphql() here means "no such owner / project invisible
  // to this token" — a resolvable null, not a failure.
  private async tryResolveQuery<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.graphql<T>(query, variables)
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null
      throw err
    }
  }

  // Full mirror snapshot of one ProjectV2: columns from the status
  // single-select field's options, items paginated 100/page until exhausted.
  // The status field is resolved up front: field(name: "Status") first (an
  // exact-name GraphQL lookup — case-sensitive on GitHub's side), falling back
  // to a single-select field elsewhere in `fields` whose name matches "status"
  // case-INSENSITIVELY (covers renamed casing/localization, e.g. "Statut").
  // Its NAME then drives each item's fieldValueByName lookup so item statuses
  // follow the same field.
  async fetchProjectSnapshot(projectV2Id: string): Promise<MirrorBoardSnapshot> {
    const meta = await this.graphql<ProjectMetaData>(
      `query ProjectMeta($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id title url updatedAt
            field(name: "Status") {
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
            fields(first: 30) {
              nodes {
                __typename
                ... on ProjectV2SingleSelectField { id name options { id name } }
              }
            }
          }
        }
      }`,
      { projectId: projectV2Id },
    )

    const project = meta.node
    // A non-ProjectV2 node id resolves the inline fragment to `{}` — guard it
    if (!project || !project.fields) {
      throw new GitHubNotFoundError(`ProjectV2 ${projectV2Id} not found or not a project`)
    }
    // Write pointer: only a CONFIDENT status field (so moves never hit an unrelated
    // field). Column source: best-effort (falls back to first single-select) so a
    // board without a "status"-named field still imports with columns.
    const statusField = resolveStatusField(project)
    const statusFieldRemoteId = statusField?.id ?? null
    const columnField = resolveColumnSourceField(project)
    const statusOptions = columnField?.options ?? []

    const itemNodes: ProjectItemNode[] = []
    let cursor: string | null = null

    do {
      const data: ProjectItemsPageData = await this.graphql<ProjectItemsPageData>(
        `query ProjectSnapshotItems($projectId: ID!, $cursor: String, $statusFieldName: String!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id isArchived updatedAt
                  fieldValueByName(name: $statusFieldName) {
                    ... on ProjectV2ItemFieldSingleSelectValue { optionId }
                  }
                  content {
                    __typename
                    ... on Issue { title url state }
                    ... on PullRequest { title url state isDraft }
                    ... on DraftIssue { title }
                  }
                }
              }
            }
          }
        }`,
        // Query item values from the column-source field so items place into the
        // columns above; when there's no single-select at all the name never matches
        // and statusRemoteId stays null.
        { projectId: projectV2Id, cursor, statusFieldName: columnField?.name ?? 'Status' },
      )

      const node = data.node
      if (!node || !node.items) {
        throw new GitHubNotFoundError(`ProjectV2 ${projectV2Id} not found or not a project`)
      }
      for (const item of node.items.nodes ?? []) {
        if (item) itemNodes.push(item)
      }
      cursor = node.items.pageInfo.hasNextPage ? node.items.pageInfo.endCursor : null
    } while (cursor !== null)

    const columns: MirrorColumnSnapshot[] = statusOptions.map((opt, index) => ({
      remoteId: opt.id,
      name: opt.name,
      position: index,
      // Terminal = a "done-ish" name, or the last option as a fallback
      isTerminal: /done|complete|closed/i.test(opt.name) || index === statusOptions.length - 1,
    }))

    const items: MirrorItemSnapshot[] = []
    for (const item of itemNodes) {
      // content is null for items this token can't read (e.g. private repo
      // issues on a project the viewer sees) — skip them rather than mirror
      // an untitled shell
      if (!item.content) continue
      const { title, url, state } = normalizeContent(item.content)
      // Placement follows the column-source field (may be a best-effort single-select
      // when no confident Status field exists); null when the board has no single-select.
      const statusRemoteId = columnField ? item.fieldValueByName?.optionId ?? null : null
      const archived = item.isArchived
      items.push({
        remoteId: item.id,
        containerRemoteId: projectV2Id,
        title,
        url,
        statusRemoteId,
        state,
        archived,
        version: item.updatedAt,
        contentHash: stableHash({ title, statusRemoteId, state, archived }),
      })
    }

    return {
      remoteId: project.id,
      title: project.title,
      url: project.url,
      version: project.updatedAt,
      statusFieldRemoteId,
      columns,
      items,
    }
  }

  // Cheap single-item version probe for pre-push conflict detection.
  // A vanished item is a legitimate "unknown version" → null, not a throw.
  async fetchItemVersion(itemId: string): Promise<string | null> {
    let data: ItemVersionData
    try {
      data = await this.graphql<ItemVersionData>(
        `query ItemVersion($itemId: ID!) {
          node(id: $itemId) { ... on ProjectV2Item { updatedAt } }
        }`,
        { itemId },
      )
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null
      throw err
    }
    return data.node?.updatedAt ?? null
  }

  // The Phase 1 write: set the Status single-select value (= move the card).
  async moveItem(
    projectV2Id: string,
    itemId: string,
    fieldId: string,
    optionId: string,
  ): Promise<{ updatedAt: string }> {
    const data = await this.graphql<MoveItemData>(
      `mutation MoveItem($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id updatedAt }
        }
      }`,
      { projectId: projectV2Id, itemId, fieldId, optionId },
    )
    const item = data.updateProjectV2ItemFieldValue?.projectV2Item
    if (!item) throw new Error('GitHub GraphQL: updateProjectV2ItemFieldValue returned no item')
    return { updatedAt: item.updatedAt }
  }

  // ── Phase 2 writes: item lifecycle (bidirectional-sync.md §3.3) ──────────

  // create_item: add a DraftIssue card to the board. Promoting a draft to a
  // real repository issue is a later phase.
  async addDraftIssue(
    projectV2Id: string,
    title: string,
    body?: string,
  ): Promise<{ itemId: string; updatedAt: string }> {
    const data = await this.graphql<AddDraftIssueData>(
      `mutation AddDraftIssue($projectId: ID!, $title: String!, $body: String) {
        addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
          projectItem { id updatedAt }
        }
      }`,
      // undefined body is dropped by JSON.stringify → GraphQL "not provided"
      { projectId: projectV2Id, title, body },
    )
    const item = data.addProjectV2DraftIssue?.projectItem
    if (!item) throw new Error('GitHub GraphQL: addProjectV2DraftIssue returned no item')
    return { itemId: item.id, updatedAt: item.updatedAt }
  }

  // update_item (draft path): edit a DraftIssue's title/body. Takes the
  // DraftIssue CONTENT id (resolve it via fetchItemContent), not the item id.
  async updateDraftIssue(
    draftIssueId: string,
    patch: { title?: string; body?: string },
  ): Promise<{ updatedAt: string }> {
    const data = await this.graphql<UpdateDraftIssueData>(
      `mutation UpdateDraftIssue($draftIssueId: ID!, $title: String, $body: String) {
        updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
          draftIssue { id updatedAt }
        }
      }`,
      // undefined fields are dropped by JSON.stringify → left unchanged remotely
      { draftIssueId, title: patch.title, body: patch.body },
    )
    const draft = data.updateProjectV2DraftIssue?.draftIssue
    if (!draft) throw new Error('GitHub GraphQL: updateProjectV2DraftIssue returned no draft issue')
    return { updatedAt: draft.updatedAt }
  }

  // close_item: archive the board item (the card leaves the board but the
  // backing issue/PR, if any, stays open on GitHub).
  async archiveItem(projectV2Id: string, itemId: string): Promise<{ updatedAt: string }> {
    const data = await this.graphql<ArchiveItemData>(
      `mutation ArchiveItem($projectId: ID!, $itemId: ID!) {
        archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
          item { id updatedAt }
        }
      }`,
      { projectId: projectV2Id, itemId },
    )
    const item = data.archiveProjectV2Item?.item
    if (!item) throw new Error('GitHub GraphQL: archiveProjectV2Item returned no item')
    return { updatedAt: item.updatedAt }
  }

  // reopen_item: restore an archived board item.
  async unarchiveItem(projectV2Id: string, itemId: string): Promise<{ updatedAt: string }> {
    const data = await this.graphql<UnarchiveItemData>(
      `mutation UnarchiveItem($projectId: ID!, $itemId: ID!) {
        unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
          item { id updatedAt }
        }
      }`,
      { projectId: projectV2Id, itemId },
    )
    const item = data.unarchiveProjectV2Item?.item
    if (!item) throw new Error('GitHub GraphQL: unarchiveProjectV2Item returned no item')
    return { updatedAt: item.updatedAt }
  }

  // Resolves what a ProjectV2 item is backed by — the dispatcher needs this to
  // pick the draft GraphQL path vs. the issue/PR REST path (update_item,
  // comment). null = item vanished, content invisible to this token, or a
  // malformed response.
  async fetchItemContent(itemId: string): Promise<ItemContentInfo | null> {
    let data: ItemContentData
    try {
      data = await this.graphql<ItemContentData>(
        `query ItemContent($itemId: ID!) {
          node(id: $itemId) {
            ... on ProjectV2Item {
              content {
                __typename
                ... on DraftIssue { id }
                ... on Issue { id number repository { nameWithOwner } }
                ... on PullRequest { id number repository { nameWithOwner } }
              }
            }
          }
        }`,
        { itemId },
      )
    } catch (err) {
      if (err instanceof GitHubNotFoundError) return null
      throw err
    }

    const content = data.node?.content
    if (!content?.id) return null
    if (content.__typename === 'DraftIssue') {
      return { type: 'DraftIssue', contentId: content.id }
    }
    if (content.__typename === 'Issue' || content.__typename === 'PullRequest') {
      const [owner, repo] = content.repository?.nameWithOwner?.split('/') ?? []
      if (typeof content.number !== 'number' || !owner || !repo) return null
      return { type: content.__typename, contentId: content.id, number: content.number, owner, repo }
    }
    return null
  }
}

// What backs a ProjectV2 item. Issue/PR variants carry the REST coordinates
// (owner/repo/number) needed for comment and (later) issue PATCH calls.
export type ItemContentInfo =
  | { type: 'DraftIssue'; contentId: string }
  | { type: 'Issue' | 'PullRequest'; contentId: string; number: number; owner: string; repo: string }

// ── Content normalization ───────────────────────────────────────────────────

function normalizeContent(content: ProjectItemContent): {
  title: string
  url: string | null
  state: 'open' | 'closed' | 'draft'
} {
  switch (content.__typename) {
    case 'DraftIssue':
      return { title: content.title, url: null, state: 'draft' }
    case 'PullRequest': {
      if (content.isDraft && content.state === 'OPEN') {
        return { title: content.title, url: content.url ?? null, state: 'draft' }
      }
      return {
        title: content.title,
        url: content.url ?? null,
        state: content.state === 'OPEN' ? 'open' : 'closed', // MERGED counts as closed
      }
    }
    case 'Issue':
    default:
      return {
        title: content.title,
        url: content.url ?? null,
        state: content.state === 'OPEN' ? 'open' : 'closed',
      }
  }
}

// The single-select field that drives board columns: the field literally
// named "Status" when it exists (and is single-select), otherwise a
// single-select field elsewhere in `fields` whose name matches "status"
// case-INSENSITIVELY — covers renamed casing/localization, which the exact
// field(name: "Status") lookup misses. Deliberately does NOT fall back to the
// first single-select field when no status-like name is found: a board whose
// first single-select is something else (Priority, Size, …) would otherwise
// get moves silently written to that unrelated field. Bailing to null instead
// leaves statusFieldRemoteId undefined so moves are safely skipped.
function resolveStatusField(
  project: Pick<ProjectMetaNode, 'field' | 'fields'>,
): { id: string; name: string; options: ProjectFieldOption[] } | null {
  const named = project.field
  if (named?.id && named.options) {
    return { id: named.id, name: named.name ?? 'Status', options: named.options }
  }
  for (const candidate of project.fields?.nodes ?? []) {
    if (
      candidate?.__typename === 'ProjectV2SingleSelectField' &&
      candidate.id && candidate.name && candidate.options &&
      candidate.name.toLowerCase() === 'status'
    ) {
      return { id: candidate.id, name: candidate.name, options: candidate.options }
    }
  }
  return null
}

// Column SOURCE field for reads/display. Prefers the confident status field; when
// none exists, falls back to the first single-select so the board still imports with
// usable columns instead of crashing applyMirrorSnapshot on empty columns. This drives
// ONLY columns + per-item placement (reads). The WRITE pointer (statusFieldRemoteId,
// from resolveStatusField) stays null unless a confident status field was found, so a
// move is never written to an unrelated field — reads degrade, writes fail safe.
function resolveColumnSourceField(
  project: Pick<ProjectMetaNode, 'field' | 'fields'>,
): { id: string; name: string; options: ProjectFieldOption[] } | null {
  const confident = resolveStatusField(project)
  if (confident) return confident
  for (const candidate of project.fields?.nodes ?? []) {
    if (
      candidate?.__typename === 'ProjectV2SingleSelectField' &&
      candidate.id && candidate.name && candidate.options
    ) {
      return { id: candidate.id, name: candidate.name, options: candidate.options }
    }
  }
  return null
}

function toBoardOption(node: ProjectNode): RemoteBoardOption {
  return { id: node.id, label: node.title, sublabel: `#${node.number}`, url: node.url }
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) ? seconds * 1000 : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── GraphQL response shapes ─────────────────────────────────────────────────

interface ProjectNode {
  id: string
  title: string
  number: number
  url: string
}

interface PageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

interface ProjectsConnection {
  pageInfo: PageInfo
  nodes: Array<ProjectNode | null> | null
}

interface ViewerProjectsData {
  viewer: { projectsV2: ProjectsConnection }
}

interface ViewerOrganizationsData {
  viewer: {
    organizations: {
      pageInfo: PageInfo
      nodes: Array<{ login: string; projectsV2: ProjectsConnection } | null> | null
    }
  }
}

interface OrgProjectsData {
  organization: { projectsV2: ProjectsConnection } | null
}

interface ResolveUserProjectData {
  user: { projectV2: ProjectNode | null } | null
}

interface ResolveOrgProjectData {
  organization: { projectV2: ProjectNode | null } | null
}

interface ProjectItemContent {
  __typename: 'Issue' | 'PullRequest' | 'DraftIssue'
  title: string
  url?: string | null
  state?: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft?: boolean
}

interface ProjectItemNode {
  id: string
  isArchived: boolean
  updatedAt: string
  fieldValueByName: { optionId?: string | null } | null
  content: ProjectItemContent | null
}

interface ProjectFieldOption {
  id: string
  name: string
}

// A field candidate from field(name:)/fields(first:) — every property is
// optional because the ProjectV2SingleSelectField inline fragment resolves to
// `{}` (plus __typename where requested) on any other field type.
interface ProjectFieldCandidate {
  __typename?: string
  id?: string
  name?: string
  options?: ProjectFieldOption[]
}

interface ProjectMetaNode {
  id: string
  title: string
  url: string | null
  updatedAt: string
  field: ProjectFieldCandidate | null
  // Optional because a node id that is not a ProjectV2 resolves to `{}`
  fields?: { nodes: Array<ProjectFieldCandidate | null> | null }
}

interface ProjectMetaData {
  node: ProjectMetaNode | null
}

interface ProjectItemsPageData {
  node: {
    // Optional because a node id that is not a ProjectV2 resolves to `{}`
    items?: {
      pageInfo: PageInfo
      nodes: Array<ProjectItemNode | null> | null
    }
  } | null
}

interface ItemVersionData {
  node: { updatedAt?: string } | null
}

interface MoveItemData {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: string; updatedAt: string } | null } | null
}

interface AddDraftIssueData {
  addProjectV2DraftIssue: { projectItem: { id: string; updatedAt: string } | null } | null
}

interface UpdateDraftIssueData {
  updateProjectV2DraftIssue: { draftIssue: { id: string; updatedAt: string } | null } | null
}

interface ArchiveItemData {
  archiveProjectV2Item: { item: { id: string; updatedAt: string } | null } | null
}

interface UnarchiveItemData {
  unarchiveProjectV2Item: { item: { id: string; updatedAt: string } | null } | null
}

interface ItemContentData {
  node: {
    // Optional because a node id that is not a ProjectV2Item resolves to `{}`
    content?: {
      __typename: string
      id?: string
      number?: number
      repository?: { nameWithOwner?: string } | null
    } | null
  } | null
}
