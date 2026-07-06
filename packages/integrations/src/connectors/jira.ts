import { stableHash } from '@creare/shared'
import { BaseConnector, UnsupportedMutationError } from './base'
import type {
  ConnectorCapabilities,
  FetchResult,
  MirrorBoardSnapshot,
  MirrorColumnSnapshot,
  MirrorItemSnapshot,
  MutationEnvelope,
  MutationOp,
  MutationResult,
  NormalizedEntity,
  RemoteBoardOption,
  RemoteRef,
  ResourceOption,
} from '../types'

// Jira moves are workflow TRANSITIONS, not a settable field — there is no real
// status field id like GitHub's Status single-select. This sentinel fills
// MirrorBoardSnapshot.statusFieldRemoteId so the generic mirror engine treats
// Jira boards as status-bearing; applyMutation ignores it and resolves the
// matching transition at push time (bidirectional-sync.md §3.2 / Phase 3).
export const JIRA_STATUS_FIELD = 'jira_status'

// Workflow position by status category: To Do < In Progress < Done.
// Jira's category keys are 'new' (To Do), 'indeterminate' (In Progress), 'done'.
const CATEGORY_ORDER: Record<string, number> = { new: 0, indeterminate: 1, done: 2 }

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

  private requireBaseUrl(): string {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) throw new Error('Jira connector is missing baseUrl — reconnect the integration')
    return baseUrl
  }

  // All BROWSEABLE projects the token can access (incl. shared), paginated
  // with startAt until isLast — /project/search caps a single page at 50.
  private async listProjects(baseUrl: string): Promise<Array<{ key: string; name: string }>> {
    const PAGE_SIZE = 50
    const projects: Array<{ key: string; name: string }> = []
    let startAt = 0
    for (;;) {
      const res = await this.fetchWithRetry(
        `${baseUrl}/rest/api/3/project/search?startAt=${startAt}&maxResults=${PAGE_SIZE}`,
        { headers: this.headers },
      )
      if (!res.ok) break

      const data = await res.json() as JiraProjectSearchResult
      const values = data.values ?? []
      projects.push(...values)
      if (data.isLast === true || values.length === 0) break
      startAt += values.length
    }
    return projects
  }

  // All Jira projects the token can access — powers the project picker
  override async listResources(): Promise<ResourceOption[]> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return []

    const projects = await this.listProjects(baseUrl)
    return projects.map((project) => ({
      id: project.key,
      label: project.name,
      sublabel: project.key,
      metadata: { projectKey: project.key },
    }))
  }

  // ── Board-mirror surface (bidirectional-sync.md Phase 3) ──────────────────
  // A Jira PROJECT is the mirror unit: its workflow statuses become columns,
  // its issues become items.

  override async listRemoteBoards(): Promise<RemoteBoardOption[]> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return []

    const projects = await this.listProjects(baseUrl)
    return projects.map((project) => ({
      id: project.key,
      label: project.name,
      sublabel: project.key,
      url: `${baseUrl}/browse/${project.key}`,
    }))
  }

  override async fetchBoardSnapshot(remoteBoardId: string): Promise<MirrorBoardSnapshot> {
    const baseUrl = this.requireBaseUrl()

    // Resolve the canonical key + display name (callers may pass key or id)
    const projectRes = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/project/${remoteBoardId}`,
      { headers: this.headers },
    )
    if (!projectRes.ok) {
      throw new Error(`Jira project ${remoteBoardId} not found or not visible to this token (HTTP ${projectRes.status})`)
    }
    const project = await projectRes.json() as JiraProject

    const columns = await this.fetchStatusColumns(baseUrl, project.key)
    const items = await this.fetchIssueSnapshots(baseUrl, project.key)

    // Jira projects carry no updatedAt of their own — the newest issue update
    // stands in as the board version (Jira version source = fields.updated)
    const version = items.reduce((max, item) => (item.version > max ? item.version : max), '')

    return {
      remoteId: project.key,
      title: project.name,
      url: `${baseUrl}/browse/${project.key}`,
      version: version || new Date().toISOString(),
      statusFieldRemoteId: JIRA_STATUS_FIELD,
      columns,
      items,
    }
  }

  // Columns = the project's statuses, deduped across issue types (the
  // /statuses endpoint returns one status list per issue type), ordered by
  // status category (To Do < In Progress < Done), then discovery order.
  private async fetchStatusColumns(baseUrl: string, projectKey: string): Promise<MirrorColumnSnapshot[]> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/project/${projectKey}/statuses`,
      { headers: this.headers },
    )
    if (!res.ok) {
      throw new Error(`Jira statuses lookup for project ${projectKey} failed (HTTP ${res.status})`)
    }

    const issueTypes = await res.json() as JiraIssueTypeStatuses[]
    const seen = new Map<string, JiraStatus>()
    for (const issueType of issueTypes) {
      for (const status of issueType.statuses ?? []) {
        if (!seen.has(status.id)) seen.set(status.id, status)
      }
    }

    // Array.prototype.sort is stable — within a category, discovery order holds
    const ordered = [...seen.values()].sort((a, b) => categoryOrder(a) - categoryOrder(b))
    return ordered.map((status, index) => ({
      remoteId: status.id,
      name: status.name,
      position: index,
      isTerminal: status.statusCategory?.key === 'done',
    }))
  }

  // Items = the project's issues, newest-updated first, paginated FULLY via
  // nextPageToken until Jira reports isLast — a truncated "complete" snapshot
  // makes the mirror reconciler treat older, still-open issues it never saw as
  // remote deletes and archive them (the bug this replaced). MAX_PAGES is a
  // runaway guard only (100 × 100 = 10 000 issues), not an expected limit —
  // same full-pagination spirit as github-projects.ts/notion.ts.
  // Uses POST /search/jql — the old /rest/api/3/search was removed from Jira
  // Cloud (HTTP 410); the replacement paginates by nextPageToken, no total.
  private async fetchIssueSnapshots(baseUrl: string, projectKey: string): Promise<MirrorItemSnapshot[]> {
    const PAGE_SIZE = 100
    const MAX_PAGES = 100
    const jql = `project = ${jqlQuote(projectKey)} ORDER BY updated DESC`
    const items: MirrorItemSnapshot[] = []
    let nextPageToken: string | undefined
    let complete = false

    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = {
        jql,
        maxResults: PAGE_SIZE,
        fields: ['summary', 'status', 'updated'],
      }
      if (nextPageToken !== undefined) body['nextPageToken'] = nextPageToken

      const res = await this.fetchWithRetry(
        `${baseUrl}/rest/api/3/search/jql`,
        { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
      )
      // A transient failure mid-pagination must abort the pull, not return the
      // issues collected so far as if they were the whole board — that partial
      // result is indistinguishable from a genuinely complete snapshot once it
      // reaches the reconciler.
      if (!res.ok) {
        throw new Error(`Jira issue search for project ${projectKey} failed mid-pagination (HTTP ${res.status})`)
      }

      const data = await res.json() as JiraMirrorSearchResult
      for (const issue of data.issues ?? []) {
        items.push(normalizeJiraIssue(issue, projectKey, baseUrl))
      }

      nextPageToken = data.nextPageToken
      if (data.isLast === true || nextPageToken === undefined) {
        complete = true
        break
      }
    }

    // If we stopped because of the page cap (not because Jira said we're done), the
    // snapshot is truncated — surface it, since the reconciler would treat the missing
    // older issues as remote deletes and wrongly archive them.
    if (!complete) {
      console.warn(
        `[jira] project ${projectKey}: hit the ${MAX_PAGES}-page cap (~${MAX_PAGES * PAGE_SIZE} issues); ` +
          `snapshot may be truncated and older issues could be wrongly archived as remote deletes.`,
      )
    }

    return items
  }

  // Single-item re-fetch for the outbox create-finalize baseline — the issue's
  // CURRENT normalized snapshot, computed by the SAME helper (normalizeJiraIssue)
  // as fetchIssueSnapshots so the contentHash matches the next pull's. ref.remoteId
  // is the issue key; ref.containerId is the project key (falls back to the key's
  // prefix). Returns null when the issue is gone (404).
  override async fetchItemSnapshot(ref: RemoteRef): Promise<MirrorItemSnapshot | null> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return null
    const issueKey = ref.remoteId
    const projectKey = ref.containerId ?? issueKey.split('-')[0] ?? issueKey
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,status,updated`,
      { headers: this.headers },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Jira issue ${issueKey} snapshot fetch failed (HTTP ${res.status})`)
    const issue = await res.json() as { key?: string; fields?: JiraMirrorIssue['fields'] }
    if (!issue.fields) return null
    return normalizeJiraIssue({ key: issue.key ?? issueKey, fields: issue.fields }, projectKey, baseUrl)
  }

  // ── Write surface (bidirectional-sync.md §3.1 — Phase 3: Jira two-way) ────

  override get capabilities(): ConnectorCapabilities {
    return { write: ['move_item', 'create_item', 'update_item', 'comment', 'close_item'] }
  }

  override async applyMutation(envelope: MutationEnvelope): Promise<MutationResult> {
    const baseUrl = this.requireBaseUrl()
    const { op } = envelope
    switch (op.kind) {
      case 'move_item':   return this.applyMove(baseUrl, op)
      case 'create_item': return this.applyCreate(baseUrl, op)
      case 'update_item': return this.applyUpdate(baseUrl, op)
      case 'comment':     return this.applyComment(baseUrl, op)
      case 'close_item':  return this.applyClose(baseUrl, op)
      default:
        throw new UnsupportedMutationError(this.source, op.kind)
    }
  }

  // Pre-push conflict probe — Jira's version source is fields.updated
  override async fetchRemoteVersion(ref: RemoteRef): Promise<string | null> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return null
    return this.fetchIssueVersion(baseUrl, ref.remoteId)
  }

  // A Jira move is a workflow TRANSITION: look up the legal transitions for the
  // issue's current status and fire the one landing on the target status. When
  // the workflow allows no such hop, that is fatal (no retry) — the user must
  // route the issue through Jira's own workflow.
  private async applyMove(baseUrl: string, op: Extract<MutationOp, { kind: 'move_item' }>): Promise<MutationResult> {
    const issueKey = op.ref.remoteId
    const transitions = await this.fetchTransitions(baseUrl, issueKey)
    const match = transitions.find((t) => t.to?.id === op.toStatusRemoteId)
    if (!match) {
      throw new Error(
        `no Jira transition from the current status of ${issueKey} to status ${op.toStatusRemoteId} — move it in Jira`,
      )
    }
    await this.postTransition(baseUrl, issueKey, match.id)
    return this.mutationResult(baseUrl, op.ref, { transitionId: match.id, transitionName: match.name ?? null })
  }

  private async applyCreate(baseUrl: string, op: Extract<MutationOp, { kind: 'create_item' }>): Promise<MutationResult> {
    const projectKey = op.container.remoteId
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary: op.title,
      issuetype: { name: op.itemType ?? 'Task' },
    }
    if (op.body !== undefined) fields['description'] = adfDoc(op.body)

    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ fields }) },
    )
    if (!res.ok) throw new Error(`Jira issue create in ${projectKey} failed (HTTP ${res.status})`)

    const created = await res.json() as { id: string; key: string }
    const ref: RemoteRef = { remoteType: 'ticket', remoteId: created.key, containerId: projectKey }
    // The create response carries no status — read it back so the baseline
    // matches what the pull snapshot will compute (fetchIssueSnapshots derives
    // state from statusCategory === 'done'). Jira assigns a real initial status
    // (e.g. "To Do"), so a hardcoded null would forever-revert on the next pull.
    const { statusRemoteId, state, version } = await this.fetchIssueStatusAndVersion(baseUrl, created.key)
    return {
      ref,
      remoteVersion: version,
      remoteUrl: `${baseUrl}/browse/${created.key}`,
      raw: { id: created.id, key: created.key },
      createdBaseline: { remoteId: created.key, title: op.title, statusRemoteId, state, archived: false },
    }
  }

  private async applyUpdate(baseUrl: string, op: Extract<MutationOp, { kind: 'update_item' }>): Promise<MutationResult> {
    if (op.patch.title === undefined) {
      throw new Error('Jira update_item supports title (summary) changes only')
    }
    const issueKey = op.ref.remoteId
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}`,
      { method: 'PUT', headers: this.headers, body: JSON.stringify({ fields: { summary: op.patch.title } }) },
    )
    if (!res.ok) throw new Error(`Jira issue update for ${issueKey} failed (HTTP ${res.status})`)
    return this.mutationResult(baseUrl, op.ref, { summary: op.patch.title })
  }

  private async applyComment(baseUrl: string, op: Extract<MutationOp, { kind: 'comment' }>): Promise<MutationResult> {
    const issueKey = op.ref.remoteId
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}/comment`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ body: adfDoc(op.body) }) },
    )
    if (!res.ok) throw new Error(`Jira comment on ${issueKey} failed (HTTP ${res.status})`)
    const comment = await res.json() as { id?: string }
    return this.mutationResult(baseUrl, op.ref, { commentId: comment.id ?? null })
  }

  // Close = transition to a Done-category status the workflow allows from here.
  // Prefer the one whose TARGET status reads like an actual completion
  // ("Done", "Complete[d]") over e.g. "Won't Do" / "Cancelled" — those are all
  // done-category, but only one means "finished". Fall back to the first.
  private async applyClose(baseUrl: string, op: Extract<MutationOp, { kind: 'close_item' }>): Promise<MutationResult> {
    const issueKey = op.ref.remoteId
    const transitions = await this.fetchTransitions(baseUrl, issueKey)
    const doneTransitions = transitions.filter((t) => t.to?.statusCategory?.key === 'done')
    const match = doneTransitions.find((t) => /done|complete/i.test(t.to?.name ?? '')) ?? doneTransitions[0]
    if (!match) {
      throw new Error(
        `no Jira transition to a Done-category status from the current status of ${issueKey} — close it in Jira`,
      )
    }
    await this.postTransition(baseUrl, issueKey, match.id)
    return this.mutationResult(baseUrl, op.ref, { transitionId: match.id, transitionName: match.name ?? null })
  }

  private async fetchTransitions(baseUrl: string, issueKey: string): Promise<JiraTransition[]> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
      { headers: this.headers },
    )
    if (!res.ok) throw new Error(`Jira transitions lookup for ${issueKey} failed (HTTP ${res.status})`)
    const data = await res.json() as { transitions?: JiraTransition[] }
    return data.transitions ?? []
  }

  private async postTransition(baseUrl: string, issueKey: string, transitionId: string): Promise<void> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}/transitions`,
      { method: 'POST', headers: this.headers, body: JSON.stringify({ transition: { id: transitionId } }) },
    )
    if (!res.ok) throw new Error(`Jira transition ${transitionId} on ${issueKey} failed (HTTP ${res.status})`)
  }

  private async fetchIssueVersion(baseUrl: string, issueKey: string): Promise<string | null> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}?fields=updated`,
      { headers: this.headers },
    )
    if (!res.ok) return null
    const data = await res.json() as { fields?: { updated?: string } }
    return data.fields?.updated ?? null
  }

  // Read a created issue's status + version to build the pull-equivalent
  // create baseline. Same state derivation as fetchIssueSnapshots. A failed
  // read-back falls back to open/null — the next pull then reconciles it.
  private async fetchIssueStatusAndVersion(
    baseUrl: string,
    issueKey: string,
  ): Promise<{ statusRemoteId: string | null; state: 'open' | 'closed'; version: string | null }> {
    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/issue/${issueKey}?fields=status,updated`,
      { headers: this.headers },
    )
    if (!res.ok) return { statusRemoteId: null, state: 'open', version: null }
    const data = await res.json() as {
      fields?: { updated?: string; status?: { id?: string; statusCategory?: { key?: string } } | null }
    }
    const statusRemoteId = data.fields?.status?.id ?? null
    const state: 'open' | 'closed' = data.fields?.status?.statusCategory?.key === 'done' ? 'closed' : 'open'
    return { statusRemoteId, state, version: data.fields?.updated ?? null }
  }

  // Every write re-reads fields.updated so the outbox can stamp the remote_link
  // with a fresh version token (best-effort — null when the read-back fails)
  private async mutationResult(baseUrl: string, ref: RemoteRef, raw: Record<string, unknown>): Promise<MutationResult> {
    const remoteVersion = await this.fetchIssueVersion(baseUrl, ref.remoteId)
    return { ref, remoteVersion, remoteUrl: `${baseUrl}/browse/${ref.remoteId}`, raw }
  }

  async fetchEntities(cursor?: string): Promise<FetchResult> {
    const baseUrl = this.config.baseUrl
    if (!baseUrl) return { entities: [], nextCursor: null }

    const maxResults = 50
    // Per-project resource scope: when a projectKey is set (source bound to a
    // global connection), constrain the JQL to that Jira project so data from
    // other projects on the same account never leaks in.
    const meta = this.config.metadata as { projectKey?: string } | undefined
    const projectKey = meta?.projectKey
    const baseJql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    const jql = projectKey ? `project = ${jqlQuote(projectKey)} AND ${baseJql}` : baseJql

    // POST /search/jql — the old /rest/api/3/search was removed from Jira Cloud
    // (HTTP 410). The cursor is the API's opaque nextPageToken, not a startAt.
    const body: Record<string, unknown> = {
      jql,
      maxResults,
      fields: ['summary', 'status', 'assignee', 'updated', 'labels', 'priority'],
    }
    if (cursor) body['nextPageToken'] = cursor

    const res = await this.fetchWithRetry(
      `${baseUrl}/rest/api/3/search/jql`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
    )
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`Jira search failed (HTTP ${res.status}): ${snippet}`)
    }

    const data = await res.json() as JiraSearchResult
    const entities: NormalizedEntity[] = (data.issues ?? []).map((issue) => ({
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

    const nextCursor = data.isLast === true || data.nextPageToken === undefined
      ? null
      : data.nextPageToken

    return { entities, nextCursor }
  }
}

function categoryOrder(status: JiraStatus): number {
  return CATEGORY_ORDER[status.statusCategory?.key ?? ''] ?? 1
}

// Normalize ONE Jira issue to a MirrorItemSnapshot — the single source of truth
// for issue hashing, shared by fetchIssueSnapshots (the pull) and
// fetchItemSnapshot (the create-finalize re-fetch) so both compute an identical
// contentHash. Jira has no per-issue archive state in this API surface, so
// archived is always false; state derives from statusCategory === 'done'.
function normalizeJiraIssue(issue: JiraMirrorIssue, projectKey: string, baseUrl: string): MirrorItemSnapshot {
  const title = issue.fields.summary
  const statusRemoteId = issue.fields.status?.id ?? null
  const state: 'open' | 'closed' = issue.fields.status?.statusCategory?.key === 'done' ? 'closed' : 'open'
  const archived = false
  return {
    remoteId: issue.key,
    containerRemoteId: projectKey,
    title,
    url: `${baseUrl}/browse/${issue.key}`,
    statusRemoteId,
    state,
    archived,
    version: issue.fields.updated,
    contentHash: stableHash({ title, statusRemoteId, state, archived }),
  }
}

// Quote a config-supplied value for interpolation into JQL. Embedded double
// quotes AND backslashes are stripped (Jira project keys can't contain them
// anyway) so a crafted value can never break out of the quoted clause — a
// trailing backslash alone would otherwise escape the closing quote.
function jqlQuote(value: string): string {
  return `"${String(value).replace(/[\\"]/g, '')}"`
}

// Minimal Atlassian Document Format wrapper — Jira Cloud v3 rejects plain text
function adfDoc(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }
}

interface JiraProjectSearchResult {
  values?: Array<{ key: string; name: string }>
  isLast?: boolean
}

interface JiraProject {
  id: string
  key: string
  name: string
}

interface JiraStatus {
  id: string
  name: string
  statusCategory?: { key?: string }
}

interface JiraIssueTypeStatuses {
  statuses?: JiraStatus[]
}

interface JiraTransition {
  id: string
  name?: string
  to?: { id?: string; name?: string; statusCategory?: { key?: string } }
}

// POST /rest/api/3/search/jql response shape — token-paginated, NO total
interface JiraMirrorSearchResult {
  issues?: JiraMirrorIssue[]
  nextPageToken?: string
  isLast?: boolean
}

interface JiraMirrorIssue {
  key: string
  fields: {
    summary: string
    updated: string
    status?: { id: string; statusCategory?: { key?: string } } | null
  }
}

// POST /rest/api/3/search/jql response shape — token-paginated, NO total
interface JiraSearchResult {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
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
