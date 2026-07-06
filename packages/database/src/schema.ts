/**
 * Pm.Os — Canonical Database Schema
 *
 * This file is the single source of truth for all data in Pm.Os.
 * Rules (enforced by AGENT-PROTOCOL.md):
 *   - All primary keys are UUIDs — never auto-increment integers
 *   - The `events` table is append-only — no UPDATE or DELETE ever
 *   - `trace_events` and `audit_log` are also append-only
 *   - All timestamps are ISO 8601 strings
 *   - Any type used by more than one domain must be defined here
 */

import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns { id: columnBuilder } so ...id() correctly spreads a named column
const id = () => ({
  id: text('id')
    .primaryKey()
    .$defaultFn(() => globalThis.crypto.randomUUID()),
})

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
}

// ---------------------------------------------------------------------------
// 1. Identity — Users & Projects
// ---------------------------------------------------------------------------

export const users = sqliteTable('users', {
  ...id(),
  email:     text('email').notNull().unique(),
  name:      text('name').notNull(),
  avatarUrl: text('avatar_url'),
  role:      text('role', { enum: ['admin', 'engineer', 'pm', 'viewer'] }).notNull().default('engineer'),
  ...timestamps,
})

export const projects = sqliteTable('projects', {
  ...id(),
  name:        text('name').notNull(),
  description: text('description'),
  ownerId:     text('owner_id').notNull().references(() => users.id),
  archivedAt:  text('archived_at'),
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 2. Security — Secrets
// ---------------------------------------------------------------------------

export const secrets = sqliteTable('secrets', {
  ...id(),
  projectId:      text('project_id').notNull().references(() => projects.id),
  name:           text('name').notNull(),             // e.g. "ANTHROPIC_API_KEY"
  encryptedValue: text('encrypted_value').notNull(),  // AES-256-GCM ciphertext, base64-encoded
  iv:             text('iv').notNull(),               // AES-256-GCM initialization vector, base64-encoded (unique per encryption)
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 3. Agent Orchestration — Workspaces, Tasks, DAG, Approval Gates
// ---------------------------------------------------------------------------

export const agentWorkspaces = sqliteTable('agent_workspaces', {
  ...id(),
  projectId:           text('project_id').notNull().references(() => projects.id),
  name:                text('name').notNull(),
  modelProvider:       text('model_provider', { enum: ['anthropic', 'openai', 'gemini', 'claude-cli', 'local'] }).notNull(),
  modelId:             text('model_id').notNull(),     // e.g. "claude-sonnet-4-6"
  status:              text('status', { enum: ['idle', 'running', 'paused', 'terminated'] }).notNull().default('idle'),
  permissionScope:     text('permission_scope').notNull().default('{}'), // JSON: { tools, repos, secrets }
  dailyTokenLimit:     integer('daily_token_limit'),
  dailyCostLimitCents: integer('daily_cost_limit_cents'),
  tokensUsedToday:     integer('tokens_used_today').notNull().default(0),
  costUsedTodayCents:  integer('cost_used_today_cents').notNull().default(0),
  tokensResetDate:     text('tokens_reset_date'),      // ISO date string — used to detect day boundary and reset counters
  lastActiveAt:        text('last_active_at'),
  ...timestamps,
})

export const tasks = sqliteTable('tasks', {
  ...id(),
  projectId:        text('project_id').notNull().references(() => projects.id),
  title:            text('title').notNull(),
  description:      text('description'),
  type:             text('type', { enum: ['human', 'agent'] }).notNull(),
  status:           text('status', {
    enum: ['pending', 'in_progress', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  }).notNull().default('pending'),
  priority:         text('priority', { enum: ['low', 'medium', 'high', 'critical'] }).notNull().default('medium'),
  assigneeId:       text('assignee_id').references(() => users.id),
  agentWorkspaceId: text('agent_workspace_id').references(() => agentWorkspaces.id),
  estimatedMinutes: integer('estimated_minutes'),
  startDate:        text('start_date'),
  dueDate:          text('due_date'),
  startedAt:        text('started_at'),
  completedAt:      text('completed_at'),
  ...timestamps,
}, (table) => ({
  projectStatusIdx: index('tasks_project_status_idx').on(table.projectId, table.status),
  projectPriorityIdx: index('tasks_project_priority_idx').on(table.projectId, table.priority),
}))

// DAG edges — fromTaskId must complete before toTaskId can start.
// IMPORTANT: The application layer must perform cycle detection before inserting edges.
// SQLite cannot enforce acyclicity at the DB level. See packages/agent-orchestration/CLAUDE.md.
export const taskEdges = sqliteTable('task_edges', {
  ...id(),
  projectId:  text('project_id').notNull().references(() => projects.id),
  fromTaskId: text('from_task_id').notNull().references(() => tasks.id),
  toTaskId:   text('to_task_id').notNull().references(() => tasks.id),
  createdAt:  text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // Prevent duplicate edges — a pair can have at most one directed dependency
  uniqueEdge: uniqueIndex('task_edges_unique_edge_idx').on(table.fromTaskId, table.toTaskId),
  // Incoming-edge lookup (WHERE to_task_id = ?) — readiness checks can't use the unique(from,to) index
  toTaskIdx: index('task_edges_to_idx').on(table.toTaskId),
}))

export const approvalGates = sqliteTable('approval_gates', {
  ...id(),
  taskId:       text('task_id').notNull().references(() => tasks.id),
  requestedBy:  text('requested_by').notNull().references(() => agentWorkspaces.id),
  reviewerId:   text('reviewer_id').notNull().references(() => users.id),
  status:       text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  context:      text('context').notNull().default('{}'), // JSON: what the agent wants to do
  reviewerNote: text('reviewer_note'),
  resolvedAt:   text('resolved_at'),
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 4. Tool Registry — Tools, Versions, Deployments
// ---------------------------------------------------------------------------

export const tools = sqliteTable('tools', {
  ...id(),
  projectId:       text('project_id').notNull().references(() => projects.id),
  name:            text('name').notNull(),
  description:     text('description'),
  createdById:     text('created_by_id').notNull().references(() => users.id),
  latestVersionId: text('latest_version_id').references((): AnySQLiteColumn => toolVersions.id), // nullable until first publish
  ...timestamps,
})

export const toolVersions = sqliteTable('tool_versions', {
  ...id(),
  toolId:         text('tool_id').notNull().references(() => tools.id),
  version:        text('version').notNull(),        // semver e.g. "1.2.3"
  schema:         text('schema').notNull(),          // JSON: input/output schema
  implementation: text('implementation').notNull(),  // JSON: tool implementation config
  changelog:      text('changelog'),
  publishedById:  text('published_by_id').notNull().references(() => users.id),
  publishedAt:    text('published_at').notNull().$defaultFn(() => new Date().toISOString()),
  createdAt:      text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const toolDeployments = sqliteTable('tool_deployments', {
  ...id(),
  toolId:            text('tool_id').notNull().references(() => tools.id),
  toolVersionId:     text('tool_version_id').notNull().references(() => toolVersions.id),
  projectId:         text('project_id').notNull().references(() => projects.id),
  status:            text('status', { enum: ['deploying', 'active', 'rolled_back', 'superseded', 'failed'] }).notNull().default('deploying'),
  deployedById:      text('deployed_by_id').notNull().references(() => users.id),
  previousVersionId: text('previous_version_id').references(() => toolVersions.id), // populated on rollback
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 5. Observability — Event Log, Traces, Audit Log
// ---------------------------------------------------------------------------

// THE append-only event log. Every domain writes here. Never update or delete.
export const events = sqliteTable('events', {
  ...id(),
  type:         text('type').notNull(),       // e.g. "task.created", "agent.started"
  domain:       text('domain').notNull(),     // e.g. "agent-orchestration", "tool-registry"
  projectId:    text('project_id').references(() => projects.id),
  actorType:    text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  actorId:      text('actor_id'),             // userId or agentWorkspaceId
  resourceType: text('resource_type'),        // e.g. "task", "tool", "secret"
  resourceId:   text('resource_id'),          // UUID of the affected entity
  payload:      text('payload').notNull().default('{}'), // JSON event-specific data
  createdAt:    text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  // NO updatedAt — this table is append-only
}, (table) => ({
  // Most common query patterns on the event log
  projectCreatedIdx: index('events_project_created_idx').on(table.projectId, table.createdAt),
  domainTypeIdx:     index('events_domain_type_idx').on(table.domain, table.type),
  resourceIdx:       index('events_resource_idx').on(table.resourceType, table.resourceId),
}))

export const traces = sqliteTable('traces', {
  ...id(),
  taskId:           text('task_id').references(() => tasks.id),
  agentWorkspaceId: text('agent_workspace_id').notNull().references(() => agentWorkspaces.id),
  projectId:        text('project_id').notNull().references(() => projects.id),
  status:           text('status', { enum: ['running', 'completed', 'failed'] }).notNull().default('running'),
  inputTokens:      integer('input_tokens').notNull().default(0),
  outputTokens:     integer('output_tokens').notNull().default(0),
  costCents:        integer('cost_cents').notNull().default(0),
  durationMs:       integer('duration_ms'),
  startedAt:        text('started_at').notNull().$defaultFn(() => new Date().toISOString()),
  completedAt:      text('completed_at'),
  createdAt:        text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  workspaceStartedIdx: index('traces_workspace_started_idx').on(table.agentWorkspaceId, table.startedAt),
  projectStatusIdx:    index('traces_project_status_idx').on(table.projectId, table.status),
}))

// Individual steps within a trace — append-only
export const traceEvents = sqliteTable('trace_events', {
  ...id(),
  traceId:        text('trace_id').notNull().references(() => traces.id),
  type:           text('type', {
    enum: ['llm_call', 'tool_call', 'tool_result', 'human_message', 'error', 'checkpoint'],
  }).notNull(),
  sequenceNumber: integer('sequence_number').notNull(),
  payload:        text('payload').notNull().default('{}'),
  durationMs:     integer('duration_ms'),
  createdAt:      text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  // NO updatedAt — append-only
})

// Immutable compliance audit trail — separate from traces
// Records who authorized what, for SOC2/HIPAA/enterprise audit
export const auditLog = sqliteTable('audit_log', {
  ...id(),
  projectId:    text('project_id').references(() => projects.id),
  actorType:    text('actor_type', { enum: ['user', 'agent', 'system'] }).notNull(),
  actorId:      text('actor_id'),
  action:       text('action').notNull(),       // e.g. "task.approved", "secret.accessed"
  resourceType: text('resource_type').notNull(),
  resourceId:   text('resource_id').notNull(),
  metadata:     text('metadata').notNull().default('{}'),
  ipAddress:    text('ip_address'),
  createdAt:    text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  // NO updatedAt — immutable by design
})

// ---------------------------------------------------------------------------
// 6. Boards — Boards, Columns, Sprints, Items, Milestones
// ---------------------------------------------------------------------------

export const boards = sqliteTable('boards', {
  ...id(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name:      text('name').notNull(),
  type:      text('type', { enum: ['kanban', 'scrum'] }).notNull().default('kanban'),
  ...timestamps,
})

export const boardColumns = sqliteTable('board_columns', {
  ...id(),
  boardId:    text('board_id').notNull().references(() => boards.id),
  name:       text('name').notNull(),
  position:   integer('position').notNull(),
  isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  wipLimit:   integer('wip_limit'),
  ...timestamps,
})

export const sprints = sqliteTable('sprints', {
  ...id(),
  boardId:   text('board_id').notNull().references(() => boards.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  name:      text('name').notNull(),
  goal:      text('goal'),
  status:    text('status', { enum: ['planning', 'active', 'completed', 'cancelled'] }).notNull().default('planning'),
  startDate: text('start_date'),
  endDate:   text('end_date'),
  velocity:  integer('velocity'),
  ...timestamps,
})

export const boardItems = sqliteTable('board_items', {
  ...id(),
  boardId:     text('board_id').notNull().references(() => boards.id),
  columnId:    text('column_id').notNull().references(() => boardColumns.id),
  taskId:      text('task_id').notNull().references(() => tasks.id),
  sprintId:    text('sprint_id').references(() => sprints.id),
  storyPoints: integer('story_points'),
  position:    integer('position').notNull().default(0),
  ...timestamps,
})

export const milestones = sqliteTable('milestones', {
  ...id(),
  projectId:   text('project_id').notNull().references(() => projects.id),
  title:       text('title').notNull(),
  description: text('description'),
  dueDate:     text('due_date'),
  status:      text('status', { enum: ['pending', 'at_risk', 'completed', 'missed'] }).notNull().default('pending'),
  completedAt: text('completed_at'),
  ...timestamps,
})

export const milestoneTasks = sqliteTable('milestone_tasks', {
  ...id(),
  milestoneId: text('milestone_id').notNull().references(() => milestones.id),
  taskId:      text('task_id').notNull().references(() => tasks.id),
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  uniqueMilestoneTask: uniqueIndex('milestone_tasks_unique_idx').on(table.milestoneId, table.taskId),
}))

// ---------------------------------------------------------------------------
// 7. Integrations — External Source Connectors, Sync, Cache, Digests, Settings
// ---------------------------------------------------------------------------

// OAuth tokens for external sources — encrypted identically to `secrets` (AES-256-GCM).
// One credential per source per project for MVP. Extensible to multiple per source in v2.
export const integrationCredentials = sqliteTable('integration_credentials', {
  ...id(),
  projectId:      text('project_id').notNull().references(() => projects.id),
  source:         text('source', { enum: ['jira', 'github', 'confluence', 'notion', 'onedrive'] }).notNull(),
  label:          text('label').notNull(),                // e.g. "Acme Jira" — user-facing display name
  encryptedToken: text('encrypted_token').notNull(),      // AES-256-GCM ciphertext, base64-encoded
  iv:             text('iv').notNull(),                   // AES-256-GCM IV, base64 (unique per encryption)
  metadata:       text('metadata').notNull().default('{}'), // JSON: per-project resource scope e.g. { owner, repo } / { projectKey } / { spaceId } / { databaseId }
  expiresAt:      text('expires_at'),                    // null = non-expiring (PAT); set for OAuth short-lived tokens
  // Links this per-project source to a global connection. Nullable for legacy rows
  // created before global connections existed. Token ciphertext is COPIED from the
  // connection so getIntegrationToken keeps decrypting the row's own copy.
  connectionId:   text('connection_id').references(() => connections.id),
  ...timestamps,
}, (table) => ({
  projectSourceIdx: index('integration_credentials_project_source_idx').on(table.projectId, table.source),
}))

// Tracks sync state per credential — last cursor, timestamp, and health status.
// One row per credential — enforced by unique constraint on credentialId.
export const integrationSyncState = sqliteTable('integration_sync_state', {
  ...id(),
  projectId:        text('project_id').notNull().references(() => projects.id),
  credentialId:     text('credential_id').notNull().references(() => integrationCredentials.id),
  source:           text('source', { enum: ['jira', 'github', 'confluence', 'notion', 'onedrive'] }).notNull(),
  status:           text('status', { enum: ['idle', 'syncing', 'error'] }).notNull().default('idle'),
  lastSyncedAt:     text('last_synced_at'),
  syncCursor:       text('sync_cursor'),         // source-specific pagination token or etag — null = full resync needed
  lastErrorMessage: text('last_error_message'),
  ...timestamps,
}, (table) => ({
  uniqueCredential: uniqueIndex('integration_sync_state_credential_unique_idx').on(table.credentialId),
}))

// Normalized external events fetched from all sources.
// Treat as append-only: create new rows on refresh rather than updating existing ones.
// TTL purging uses soft-delete via purgedAt; rows purged more than 7 days ago are
// hard-deleted by the sync engine to bound growth.
export const externalEventCache = sqliteTable('external_event_cache', {
  ...id(),
  projectId:    text('project_id').notNull().references(() => projects.id),
  credentialId: text('credential_id').notNull().references(() => integrationCredentials.id),
  source:       text('source', { enum: ['jira', 'github', 'confluence', 'notion', 'onedrive'] }).notNull(),
  entityType:   text('entity_type').notNull(),            // e.g. "ticket", "pr", "page", "note", "file"
  entityId:     text('entity_id').notNull(),              // source-system identifier (e.g. "PROJ-89", "412")
  entityUrl:    text('entity_url'),
  payload:      text('payload').notNull().default('{}'),  // JSON: normalized entity data (title, status, assignee, etc.)
  // Cached PM classifier result — JSON { bucket, urgency, riskType, suggestedAction }.
  // null = not yet classified. Rows are immutable per fetch, so a stored classification
  // stays valid until the row is superseded by a fresh fetch (which creates a new row).
  classification: text('classification'),
  classifiedAt:   text('classified_at'),
  fetchedAt:    text('fetched_at').notNull().$defaultFn(() => new Date().toISOString()),
  purgedAt:     text('purged_at'),                        // soft-delete for TTL — query WHERE purgedAt IS NULL for active
  createdAt:    text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  // NO updatedAt — append-only; new fetch = new row
}, (table) => ({
  // Primary lookup for cross-source entity correlation (Jira ↔ GitHub ticket ID matching)
  sourceEntityIdx:   index('ext_cache_source_entity_idx').on(table.source, table.entityType, table.entityId),
  // Timeline queries per project (dashboard loads, sync windows)
  projectFetchedIdx: index('ext_cache_project_fetched_idx').on(table.projectId, table.fetchedAt),
  // Sync-engine purge UPDATE filters on credentialId + purgedAt IS NULL
  credentialPurgedIdx: index('external_event_cache_credential_purged_idx').on(table.credentialId, table.purgedAt),
}))

// AI-generated PM digest snapshots, cached with an expiry window.
// Dashboard reads from here first; regenerates if validUntil has passed.
export const pmDigestCache = sqliteTable('pm_digest_cache', {
  ...id(),
  projectId:   text('project_id').notNull().references(() => projects.id),
  digestType:  text('digest_type', {
    enum: ['morning_brief', 'sprint_health', 'decisions_and_docs', 'risk_radar'],
  }).notNull(),
  content:     text('content').notNull(),      // JSON: structured digest — type-specific shape
  generatedAt: text('generated_at').notNull().$defaultFn(() => new Date().toISOString()),
  validUntil:  text('valid_until').notNull(),  // regenerate after this ISO timestamp (typically now + 15m)
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// Per-user, per-project settings — PM delegation rules, classifier overrides, dashboard preferences.
// projectId is required in v1; global (cross-project) settings are a v2 concern.
export const userSettings = sqliteTable('user_settings', {
  ...id(),
  userId:    text('user_id').notNull().references(() => users.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  key:       text('key').notNull(),    // e.g. "pm.delegation.auto_approve_doc_updates"
  value:     text('value').notNull(), // JSON-encoded value — always parse before use
  ...timestamps,
}, (table) => ({
  uniqueUserProjectKey: uniqueIndex('user_settings_unique_idx').on(table.userId, table.projectId, table.key),
}))

// ---------------------------------------------------------------------------
// 7b. Global (workspace-level) — Connections & Settings
// ---------------------------------------------------------------------------

// Workspace-level tool connections — NOT project-scoped. Tokens encrypted
// identically to `secrets` (AES-256-GCM). One row per connected account.
export const connections = sqliteTable('connections', {
  ...id(),
  source:         text('source', { enum: ['github', 'jira', 'confluence', 'notion', 'onedrive'] }).notNull(),
  label:          text('label').notNull(),                  // e.g. "Acme GitHub" — user-facing display name
  encryptedToken: text('encrypted_token').notNull(),        // AES-256-GCM ciphertext, base64-encoded
  iv:             text('iv').notNull(),                     // AES-256-GCM IV, base64 (unique per encryption)
  metadata:       text('metadata').notNull().default('{}'), // JSON: account-level data e.g. { baseUrl, email }
  expiresAt:      text('expires_at'),                       // null = non-expiring (PAT); set for OAuth short-lived tokens
  ...timestamps,
})

// Workspace-level encrypted settings — e.g. the global ANTHROPIC_API_KEY.
// Values encrypted identically to `secrets` (AES-256-GCM).
export const globalSettings = sqliteTable('global_settings', {
  ...id(),
  key:            text('key').notNull().unique(),     // e.g. 'ANTHROPIC_API_KEY'
  encryptedValue: text('encrypted_value').notNull(),  // AES-256-GCM ciphertext, base64-encoded
  iv:             text('iv').notNull(),               // AES-256-GCM IV, base64 (unique per encryption)
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 8. Cross-Cutting — Notifications, Cost Records
// ---------------------------------------------------------------------------

export const notifications = sqliteTable('notifications', {
  ...id(),
  userId:       text('user_id').notNull().references(() => users.id),
  projectId:    text('project_id').references(() => projects.id),
  type:         text('type', {
    enum: ['approval_needed', 'agent_failed', 'deployment_complete', 'cost_warning', 'mention'],
  }).notNull(),
  title:        text('title').notNull(),
  body:         text('body').notNull(),
  resourceType: text('resource_type'),
  resourceId:   text('resource_id'),
  readAt:       text('read_at'),
  createdAt:    text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // Powers unread count badge — the most frequent query on this table
  userReadIdx: index('notifications_user_read_idx').on(table.userId, table.readAt),
}))

export const costRecords = sqliteTable('cost_records', {
  ...id(),
  projectId:        text('project_id').notNull().references(() => projects.id),
  agentWorkspaceId: text('agent_workspace_id').notNull().references(() => agentWorkspaces.id),
  traceId:          text('trace_id').references(() => traces.id),
  provider:         text('provider', { enum: ['anthropic', 'openai', 'gemini', 'claude-cli', 'local'] }).notNull(),
  modelId:          text('model_id').notNull(),
  inputTokens:      integer('input_tokens').notNull(),
  outputTokens:     integer('output_tokens').notNull(),
  costCents:        integer('cost_cents').notNull(),
  recordedAt:       text('recorded_at').notNull().$defaultFn(() => new Date().toISOString()),
  createdAt:        text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// ---------------------------------------------------------------------------
// 8. Eval & Intelligence — eval runs + team memory (Phase 4)
// ---------------------------------------------------------------------------

// A single execution of an eval suite, with aggregate scores and per-case detail.
export const evalRuns = sqliteTable('eval_runs', {
  ...id(),
  projectId: text('project_id').notNull().references(() => projects.id),
  suite:     text('suite').notNull(),            // logical name of the eval set
  runner:    text('runner').notNull(),           // how outputs were produced, e.g. "anthropic:claude-sonnet-4-6"
  total:     integer('total').notNull(),
  passed:    integer('passed').notNull(),
  passRate:  real('pass_rate').notNull(),        // 0..1
  avgScore:  real('avg_score').notNull(),        // 0..1
  results:   text('results').notNull().default('[]'), // JSON: EvalCaseResult[]
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectSuiteIdx: index('eval_runs_project_suite_idx').on(table.projectId, table.suite),
}))

// Team memory — durable learnings captured from agent runs, reviews, and evals,
// recalled to inform future work.
export const learnings = sqliteTable('learnings', {
  ...id(),
  projectId: text('project_id').notNull().references(() => projects.id),
  source:    text('source', { enum: ['agent_run', 'review', 'eval', 'manual'] }).notNull(),
  taskId:    text('task_id').references(() => tasks.id),
  title:     text('title').notNull(),
  content:   text('content').notNull(),
  tags:      text('tags').notNull().default('[]'), // JSON: string[]
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  projectIdx: index('learnings_project_idx').on(table.projectId),
}))

// ---------------------------------------------------------------------------
// 9. Bidirectional Sync — Remote Links, Mutation Queue, Conflicts
// See docs/architecture/bidirectional-sync.md
// ---------------------------------------------------------------------------

// Identity map between local entities and their remote counterparts.
// One row per (local entity ↔ remote entity) pairing, scoped to a credential.
export const remoteLinks = sqliteTable('remote_links', {
  ...id(),
  projectId:         text('project_id').notNull().references(() => projects.id),
  credentialId:      text('credential_id').notNull().references(() => integrationCredentials.id),
  source:            text('source').notNull(),               // e.g. "jira", "github"
  localType:         text('local_type', { enum: ['board', 'board_column', 'board_item', 'task'] }).notNull(),
  localId:           text('local_id').notNull(),             // UUID of the local entity
  remoteType:        text('remote_type').notNull(),          // source-specific, e.g. "issue", "epic"
  remoteId:          text('remote_id').notNull(),            // source-system identifier
  containerRemoteId: text('container_remote_id'),            // remote parent, e.g. board/project the entity lives in
  remoteUrl:         text('remote_url'),
  remoteVersion:     text('remote_version'),                 // etag / updated-at / version token from the source
  lastSyncedHash:    text('last_synced_hash'),               // hash of last synced canonical state — change detection
  lastPulledAt:      text('last_pulled_at'),
  lastPushedAt:      text('last_pushed_at'),
  deletedAt:         text('deleted_at'),                     // soft-delete tombstone — keeps identity for late echoes
  ...timestamps,
}, (table) => ({
  // A local entity maps to at most one remote entity
  uniqueLocal:      uniqueIndex('remote_links_local_unique_idx').on(table.localType, table.localId),
  // A remote entity maps to at most one local entity per credential AND remote
  // container — GitHub's default status-option ids (Todo/In Progress/Done) are
  // identical across ProjectV2 projects, so one credential mirroring several
  // projects legitimately holds the same option remoteId once per project.
  uniqueRemote:     uniqueIndex('remote_links_remote_unique_idx').on(table.credentialId, table.remoteType, table.remoteId, table.containerRemoteId),
  projectSourceIdx: index('remote_links_project_source_idx').on(table.projectId, table.source),
}))

// Outbound mutation queue — local changes waiting to be pushed to the source.
// opId is the idempotency key; workers drain per credential in createdAt order.
export const mutationQueue = sqliteTable('mutation_queue', {
  ...id(),
  opId:         text('op_id').notNull().unique(),            // idempotency key for the operation
  projectId:    text('project_id').notNull().references(() => projects.id),
  credentialId: text('credential_id').notNull().references(() => integrationCredentials.id),
  source:       text('source').notNull(),
  remoteLinkId: text('remote_link_id').references(() => remoteLinks.id), // null for creates (link not yet established)
  kind:         text('kind').notNull(),                      // e.g. "create", "update", "move", "delete"
  payload:      text('payload').notNull().default('{}'),     // JSON: operation-specific data
  baseVersion:  text('base_version'),                        // remote version the mutation was computed against
  status:       text('status').notNull().default('pending'), // pending | in_flight | applied | failed | conflicted | cancelled
  attempts:     integer('attempts').notNull().default(0),
  lastError:    text('last_error'),
  result:       text('result'),                              // JSON: response data from the source on success
  appliedAt:    text('applied_at'),
  ...timestamps,
}, (table) => ({
  // Worker drain query: WHERE credential_id = ? AND status = 'pending' ORDER BY created_at
  credentialStatusCreatedIdx: index('mutation_queue_credential_status_created_idx')
    .on(table.credentialId, table.status, table.createdAt),
}))

// Three-way merge conflicts detected during sync — base/local/remote snapshots
// preserved verbatim so the user (or a policy) can resolve later.
export const syncConflicts = sqliteTable('sync_conflicts', {
  ...id(),
  projectId:      text('project_id').notNull().references(() => projects.id),
  remoteLinkId:   text('remote_link_id').notNull().references(() => remoteLinks.id),
  mutationId:     text('mutation_id').references(() => mutationQueue.id), // null for pull-side conflicts
  baseSnapshot:   text('base_snapshot').notNull().default('{}'),   // JSON: last common ancestor
  localSnapshot:  text('local_snapshot').notNull().default('{}'),  // JSON: local state at detection
  remoteSnapshot: text('remote_snapshot').notNull().default('{}'), // JSON: remote state at detection
  resolution:     text('resolution'),                              // e.g. "local_wins", "remote_wins", "merged" — null = unresolved
  resolvedAt:     text('resolved_at'),
  createdAt:      text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  // NO updatedAt — conflicts are resolved once, then immutable
}, (table) => ({
  // Unresolved-conflicts lookup: WHERE project_id = ? AND resolved_at IS NULL
  projectResolvedIdx: index('sync_conflicts_project_resolved_idx').on(table.projectId, table.resolvedAt),
}))

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  ownedProjects: many(projects),
  assignedTasks: many(tasks),
  approvalGates: many(approvalGates),
  notifications: many(notifications),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner:           one(users, { fields: [projects.ownerId], references: [users.id] }),
  tasks:           many(tasks),
  tools:           many(tools),
  boards:          many(boards),
  milestones:      many(milestones),
  secrets:         many(secrets),
  agentWorkspaces: many(agentWorkspaces),
}))

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project:        one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee:       one(users, { fields: [tasks.assigneeId], references: [users.id] }),
  agentWorkspace: one(agentWorkspaces, { fields: [tasks.agentWorkspaceId], references: [agentWorkspaces.id] }),
  fromEdges:      many(taskEdges, { relationName: 'fromTask' }),
  toEdges:        many(taskEdges, { relationName: 'toTask' }),
  approvalGates:  many(approvalGates),
  boardItems:     many(boardItems),
  traces:         many(traces),
  milestoneTasks: many(milestoneTasks),
}))

export const taskEdgesRelations = relations(taskEdges, ({ one }) => ({
  fromTask: one(tasks, { fields: [taskEdges.fromTaskId], references: [tasks.id], relationName: 'fromTask' }),
  toTask:   one(tasks, { fields: [taskEdges.toTaskId], references: [tasks.id], relationName: 'toTask' }),
}))

export const toolsRelations = relations(tools, ({ one, many }) => ({
  project:       one(projects, { fields: [tools.projectId], references: [projects.id] }),
  createdBy:     one(users, { fields: [tools.createdById], references: [users.id] }),
  latestVersion: one(toolVersions, { fields: [tools.latestVersionId], references: [toolVersions.id] }),
  versions:      many(toolVersions),
  deployments:   many(toolDeployments),
}))

export const toolVersionsRelations = relations(toolVersions, ({ one }) => ({
  tool:        one(tools, { fields: [toolVersions.toolId], references: [tools.id] }),
  publishedBy: one(users, { fields: [toolVersions.publishedById], references: [users.id] }),
}))

export const tracesRelations = relations(traces, ({ one, many }) => ({
  task:           one(tasks, { fields: [traces.taskId], references: [tasks.id] }),
  agentWorkspace: one(agentWorkspaces, { fields: [traces.agentWorkspaceId], references: [agentWorkspaces.id] }),
  project:        one(projects, { fields: [traces.projectId], references: [projects.id] }),
  traceEvents:    many(traceEvents),
  costRecords:    many(costRecords),
}))

export const boardsRelations = relations(boards, ({ one, many }) => ({
  project: one(projects, { fields: [boards.projectId], references: [projects.id] }),
  columns: many(boardColumns),
  sprints: many(sprints),
  items:   many(boardItems),
}))

export const boardItemsRelations = relations(boardItems, ({ one }) => ({
  board:  one(boards, { fields: [boardItems.boardId], references: [boards.id] }),
  column: one(boardColumns, { fields: [boardItems.columnId], references: [boardColumns.id] }),
  task:   one(tasks, { fields: [boardItems.taskId], references: [tasks.id] }),
  sprint: one(sprints, { fields: [boardItems.sprintId], references: [sprints.id] }),
}))

export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  project:        one(projects, { fields: [milestones.projectId], references: [projects.id] }),
  milestoneTasks: many(milestoneTasks),
}))

export const integrationCredentialsRelations = relations(integrationCredentials, ({ one, many }) => ({
  project:   one(projects, { fields: [integrationCredentials.projectId], references: [projects.id] }),
  syncState: many(integrationSyncState),
  eventCache: many(externalEventCache),
}))

export const integrationSyncStateRelations = relations(integrationSyncState, ({ one }) => ({
  project:    one(projects, { fields: [integrationSyncState.projectId], references: [projects.id] }),
  credential: one(integrationCredentials, { fields: [integrationSyncState.credentialId], references: [integrationCredentials.id] }),
}))

export const externalEventCacheRelations = relations(externalEventCache, ({ one }) => ({
  project:    one(projects, { fields: [externalEventCache.projectId], references: [projects.id] }),
  credential: one(integrationCredentials, { fields: [externalEventCache.credentialId], references: [integrationCredentials.id] }),
}))

export const pmDigestCacheRelations = relations(pmDigestCache, ({ one }) => ({
  project: one(projects, { fields: [pmDigestCache.projectId], references: [projects.id] }),
}))

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user:    one(users, { fields: [userSettings.userId], references: [users.id] }),
  project: one(projects, { fields: [userSettings.projectId], references: [projects.id] }),
}))

export const remoteLinksRelations = relations(remoteLinks, ({ one, many }) => ({
  project:    one(projects, { fields: [remoteLinks.projectId], references: [projects.id] }),
  credential: one(integrationCredentials, { fields: [remoteLinks.credentialId], references: [integrationCredentials.id] }),
  mutations:  many(mutationQueue),
  conflicts:  many(syncConflicts),
}))

export const mutationQueueRelations = relations(mutationQueue, ({ one }) => ({
  project:    one(projects, { fields: [mutationQueue.projectId], references: [projects.id] }),
  credential: one(integrationCredentials, { fields: [mutationQueue.credentialId], references: [integrationCredentials.id] }),
  remoteLink: one(remoteLinks, { fields: [mutationQueue.remoteLinkId], references: [remoteLinks.id] }),
}))

export const syncConflictsRelations = relations(syncConflicts, ({ one }) => ({
  project:    one(projects, { fields: [syncConflicts.projectId], references: [projects.id] }),
  remoteLink: one(remoteLinks, { fields: [syncConflicts.remoteLinkId], references: [remoteLinks.id] }),
  mutation:   one(mutationQueue, { fields: [syncConflicts.mutationId], references: [mutationQueue.id] }),
}))

// ---------------------------------------------------------------------------
// Exported types — use these everywhere, never hand-write interfaces
// ---------------------------------------------------------------------------

import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'

export type User              = InferSelectModel<typeof users>
export type NewUser           = InferInsertModel<typeof users>
export type Project           = InferSelectModel<typeof projects>
export type NewProject        = InferInsertModel<typeof projects>
export type Secret            = InferSelectModel<typeof secrets>
export type NewSecret         = InferInsertModel<typeof secrets>
export type AgentWorkspace    = InferSelectModel<typeof agentWorkspaces>
export type NewAgentWorkspace = InferInsertModel<typeof agentWorkspaces>
export type Task              = InferSelectModel<typeof tasks>
export type NewTask           = InferInsertModel<typeof tasks>
export type TaskEdge          = InferSelectModel<typeof taskEdges>
export type NewTaskEdge       = InferInsertModel<typeof taskEdges>
export type ApprovalGate      = InferSelectModel<typeof approvalGates>
export type NewApprovalGate   = InferInsertModel<typeof approvalGates>
export type Tool              = InferSelectModel<typeof tools>
export type NewTool           = InferInsertModel<typeof tools>
export type ToolVersion       = InferSelectModel<typeof toolVersions>
export type NewToolVersion    = InferInsertModel<typeof toolVersions>
export type ToolDeployment    = InferSelectModel<typeof toolDeployments>
export type NewToolDeployment = InferInsertModel<typeof toolDeployments>
export type Event             = InferSelectModel<typeof events>
export type NewEvent          = InferInsertModel<typeof events>
export type Trace             = InferSelectModel<typeof traces>
export type NewTrace          = InferInsertModel<typeof traces>
export type TraceEvent        = InferSelectModel<typeof traceEvents>
export type NewTraceEvent     = InferInsertModel<typeof traceEvents>
export type AuditLog          = InferSelectModel<typeof auditLog>
export type NewAuditLog       = InferInsertModel<typeof auditLog>
export type Board             = InferSelectModel<typeof boards>
export type NewBoard          = InferInsertModel<typeof boards>
export type BoardColumn       = InferSelectModel<typeof boardColumns>
export type NewBoardColumn    = InferInsertModel<typeof boardColumns>
export type Sprint            = InferSelectModel<typeof sprints>
export type NewSprint         = InferInsertModel<typeof sprints>
export type BoardItem         = InferSelectModel<typeof boardItems>
export type NewBoardItem      = InferInsertModel<typeof boardItems>
export type Milestone         = InferSelectModel<typeof milestones>
export type NewMilestone      = InferInsertModel<typeof milestones>
export type Notification      = InferSelectModel<typeof notifications>
export type NewNotification   = InferInsertModel<typeof notifications>
export type CostRecord                  = InferSelectModel<typeof costRecords>
export type NewCostRecord               = InferInsertModel<typeof costRecords>
export type IntegrationCredential       = InferSelectModel<typeof integrationCredentials>
export type NewIntegrationCredential    = InferInsertModel<typeof integrationCredentials>
export type IntegrationSyncState        = InferSelectModel<typeof integrationSyncState>
export type NewIntegrationSyncState     = InferInsertModel<typeof integrationSyncState>
export type ExternalEventCache          = InferSelectModel<typeof externalEventCache>
export type NewExternalEventCache       = InferInsertModel<typeof externalEventCache>
export type PmDigestCache               = InferSelectModel<typeof pmDigestCache>
export type NewPmDigestCache            = InferInsertModel<typeof pmDigestCache>
export type UserSetting                 = InferSelectModel<typeof userSettings>
export type NewUserSetting              = InferInsertModel<typeof userSettings>
export type EvalRun                     = InferSelectModel<typeof evalRuns>
export type NewEvalRun                  = InferInsertModel<typeof evalRuns>
export type Learning                    = InferSelectModel<typeof learnings>
export type NewLearning                 = InferInsertModel<typeof learnings>
export type Connection                  = InferSelectModel<typeof connections>
export type NewConnection               = InferInsertModel<typeof connections>
export type GlobalSetting               = InferSelectModel<typeof globalSettings>
export type NewGlobalSetting            = InferInsertModel<typeof globalSettings>
export type RemoteLink                  = InferSelectModel<typeof remoteLinks>
export type NewRemoteLink               = InferInsertModel<typeof remoteLinks>
export type MutationQueueRow            = InferSelectModel<typeof mutationQueue>
export type NewMutationQueueRow         = InferInsertModel<typeof mutationQueue>
export type SyncConflict                = InferSelectModel<typeof syncConflicts>
export type NewSyncConflict             = InferInsertModel<typeof syncConflicts>

export const SCHEMA_VERSION = '1.8.0'
