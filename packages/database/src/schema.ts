/**
 * Creare — Canonical Database Schema
 *
 * This file is the single source of truth for all data in Creare.
 * Rules (enforced by AGENT-PROTOCOL.md):
 *   - All primary keys are UUIDs — never auto-increment integers
 *   - The `events` table is append-only — no UPDATE or DELETE ever
 *   - `trace_events` and `audit_log` are also append-only
 *   - All timestamps are ISO 8601 strings
 *   - Any type used by more than one domain must be defined here
 */

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => globalThis.crypto.randomUUID())

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
// 2. Security — Secrets & Agent Permissions
// ---------------------------------------------------------------------------

export const secrets = sqliteTable('secrets', {
  ...id(),
  projectId:      text('project_id').notNull().references(() => projects.id),
  name:           text('name').notNull(),             // e.g. "ANTHROPIC_API_KEY"
  encryptedValue: text('encrypted_value').notNull(),  // AES-256-GCM encrypted at rest
  ...timestamps,
})

// ---------------------------------------------------------------------------
// 3. Agent Orchestration — Workspaces, Tasks, DAG, Approval Gates
// ---------------------------------------------------------------------------

export const agentWorkspaces = sqliteTable('agent_workspaces', {
  ...id(),
  projectId:           text('project_id').notNull().references(() => projects.id),
  name:                text('name').notNull(),
  modelProvider:       text('model_provider', { enum: ['anthropic', 'openai', 'gemini', 'local'] }).notNull(),
  modelId:             text('model_id').notNull(),     // e.g. "claude-sonnet-4-6"
  status:              text('status', { enum: ['idle', 'running', 'paused', 'terminated'] }).notNull().default('idle'),
  permissionScope:     text('permission_scope').notNull().default('{}'), // JSON: { tools, repos, secrets }
  dailyTokenLimit:     integer('daily_token_limit'),
  dailyCostLimitCents: integer('daily_cost_limit_cents'),
  tokensUsedToday:     integer('tokens_used_today').notNull().default(0),
  costUsedTodayCents:  integer('cost_used_today_cents').notNull().default(0),
  lastActiveAt:        text('last_active_at'),
  ...timestamps,
})

export const tasks = sqliteTable('tasks', {
  ...id(),
  projectId:          text('project_id').notNull().references(() => projects.id),
  title:              text('title').notNull(),
  description:        text('description'),
  type:               text('type', { enum: ['human', 'agent'] }).notNull(),
  status:             text('status', {
    enum: ['pending', 'in_progress', 'waiting_approval', 'completed', 'failed', 'cancelled'],
  }).notNull().default('pending'),
  priority:           text('priority', { enum: ['low', 'medium', 'high', 'critical'] }).notNull().default('medium'),
  assigneeId:         text('assignee_id').references(() => users.id),         // human tasks
  agentWorkspaceId:   text('agent_workspace_id').references(() => agentWorkspaces.id), // agent tasks
  estimatedMinutes:   integer('estimated_minutes'),
  startedAt:          text('started_at'),
  completedAt:        text('completed_at'),
  ...timestamps,
})

// DAG edges — fromTaskId must complete before toTaskId can start
export const taskEdges = sqliteTable('task_edges', {
  ...id(),
  projectId:   text('project_id').notNull().references(() => projects.id),
  fromTaskId:  text('from_task_id').notNull().references(() => tasks.id),
  toTaskId:    text('to_task_id').notNull().references(() => tasks.id),
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

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
  latestVersionId: text('latest_version_id'), // FK to toolVersions — set after first publish
  ...timestamps,
})

export const toolVersions = sqliteTable('tool_versions', {
  ...id(),
  toolId:          text('tool_id').notNull().references(() => tools.id),
  version:         text('version').notNull(),         // semver e.g. "1.2.3"
  schema:          text('schema').notNull(),           // JSON: input/output schema
  implementation:  text('implementation').notNull(),   // JSON: tool implementation config
  changelog:       text('changelog'),
  publishedById:   text('published_by_id').notNull().references(() => users.id),
  publishedAt:     text('published_at').notNull().$defaultFn(() => new Date().toISOString()),
  createdAt:       text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const toolDeployments = sqliteTable('tool_deployments', {
  ...id(),
  toolId:            text('tool_id').notNull().references(() => tools.id),
  toolVersionId:     text('tool_version_id').notNull().references(() => toolVersions.id),
  projectId:         text('project_id').notNull().references(() => projects.id),
  status:            text('status', { enum: ['deploying', 'active', 'rolled_back', 'failed'] }).notNull().default('deploying'),
  deployedById:      text('deployed_by_id').notNull().references(() => users.id),
  previousVersionId: text('previous_version_id').references(() => toolVersions.id), // enables rollback
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
})

export const traces = sqliteTable('traces', {
  ...id(),
  taskId:            text('task_id').references(() => tasks.id),
  agentWorkspaceId:  text('agent_workspace_id').notNull().references(() => agentWorkspaces.id),
  projectId:         text('project_id').notNull().references(() => projects.id),
  status:            text('status', { enum: ['running', 'completed', 'failed'] }).notNull().default('running'),
  inputTokens:       integer('input_tokens').notNull().default(0),
  outputTokens:      integer('output_tokens').notNull().default(0),
  costCents:         integer('cost_cents').notNull().default(0),
  durationMs:        integer('duration_ms'),
  startedAt:         text('started_at').notNull().$defaultFn(() => new Date().toISOString()),
  completedAt:       text('completed_at'),
  createdAt:         text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// Individual steps within a trace — append-only
export const traceEvents = sqliteTable('trace_events', {
  ...id(),
  traceId:        text('trace_id').notNull().references(() => traces.id),
  type:           text('type', {
    enum: ['llm_call', 'tool_call', 'tool_result', 'human_message', 'error', 'checkpoint'],
  }).notNull(),
  sequenceNumber: integer('sequence_number').notNull(),
  payload:        text('payload').notNull().default('{}'), // JSON step data
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
  action:       text('action').notNull(),      // e.g. "task.approved", "secret.accessed"
  resourceType: text('resource_type').notNull(),
  resourceId:   text('resource_id').notNull(),
  metadata:     text('metadata').notNull().default('{}'), // JSON additional context
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
  name:       text('name').notNull(),          // e.g. "To Do", "In Progress", "Done"
  position:   integer('position').notNull(),
  isTerminal: integer('is_terminal', { mode: 'boolean' }).notNull().default(false),
  wipLimit:   integer('wip_limit'),            // work-in-progress limit
  ...timestamps,
})

export const sprints = sqliteTable('sprints', {
  ...id(),
  boardId:   text('board_id').notNull().references(() => boards.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  name:      text('name').notNull(),
  goal:      text('goal'),
  status:    text('status', { enum: ['planning', 'active', 'completed', 'cancelled'] }).notNull().default('planning'),
  startDate: text('start_date'),               // ISO date string
  endDate:   text('end_date'),
  velocity:  integer('velocity'),              // story points completed
  ...timestamps,
})

export const boardItems = sqliteTable('board_items', {
  ...id(),
  boardId:     text('board_id').notNull().references(() => boards.id),
  columnId:    text('column_id').notNull().references(() => boardColumns.id),
  taskId:      text('task_id').notNull().references(() => tasks.id),
  sprintId:    text('sprint_id').references(() => sprints.id),
  storyPoints: integer('story_points'),
  position:    integer('position').notNull().default(0), // ordering within column
  ...timestamps,
})

export const milestones = sqliteTable('milestones', {
  ...id(),
  projectId:   text('project_id').notNull().references(() => projects.id),
  title:       text('title').notNull(),
  description: text('description'),
  dueDate:     text('due_date'),               // ISO date string
  status:      text('status', { enum: ['pending', 'at_risk', 'completed', 'missed'] }).notNull().default('pending'),
  completedAt: text('completed_at'),
  ...timestamps,
})

// Join table linking tasks to milestones
export const milestoneTasks = sqliteTable('milestone_tasks', {
  ...id(),
  milestoneId: text('milestone_id').notNull().references(() => milestones.id),
  taskId:      text('task_id').notNull().references(() => tasks.id),
  createdAt:   text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// ---------------------------------------------------------------------------
// 7. Cross-Cutting — Notifications, Cost Records
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
})

export const costRecords = sqliteTable('cost_records', {
  ...id(),
  projectId:        text('project_id').notNull().references(() => projects.id),
  agentWorkspaceId: text('agent_workspace_id').notNull().references(() => agentWorkspaces.id),
  traceId:          text('trace_id').references(() => traces.id),
  provider:         text('provider', { enum: ['anthropic', 'openai', 'gemini', 'local'] }).notNull(),
  modelId:          text('model_id').notNull(),
  inputTokens:      integer('input_tokens').notNull(),
  outputTokens:     integer('output_tokens').notNull(),
  costCents:        integer('cost_cents').notNull(),     // store as cents to avoid float errors
  recordedAt:       text('recorded_at').notNull().$defaultFn(() => new Date().toISOString()),
  createdAt:        text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  ownedProjects:    many(projects),
  assignedTasks:    many(tasks),
  approvalGates:    many(approvalGates),
  notifications:    many(notifications),
}))

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner:            one(users, { fields: [projects.ownerId], references: [users.id] }),
  tasks:            many(tasks),
  tools:            many(tools),
  boards:           many(boards),
  milestones:       many(milestones),
  secrets:          many(secrets),
  agentWorkspaces:  many(agentWorkspaces),
}))

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project:          one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee:         one(users, { fields: [tasks.assigneeId], references: [users.id] }),
  agentWorkspace:   one(agentWorkspaces, { fields: [tasks.agentWorkspaceId], references: [agentWorkspaces.id] }),
  fromEdges:        many(taskEdges, { relationName: 'fromTask' }),
  toEdges:          many(taskEdges, { relationName: 'toTask' }),
  approvalGates:    many(approvalGates),
  boardItems:       many(boardItems),
  traces:           many(traces),
  milestoneTasks:   many(milestoneTasks),
}))

export const taskEdgesRelations = relations(taskEdges, ({ one }) => ({
  fromTask: one(tasks, { fields: [taskEdges.fromTaskId], references: [tasks.id], relationName: 'fromTask' }),
  toTask:   one(tasks, { fields: [taskEdges.toTaskId], references: [tasks.id], relationName: 'toTask' }),
}))

export const toolsRelations = relations(tools, ({ one, many }) => ({
  project:     one(projects, { fields: [tools.projectId], references: [projects.id] }),
  createdBy:   one(users, { fields: [tools.createdById], references: [users.id] }),
  versions:    many(toolVersions),
  deployments: many(toolDeployments),
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

// ---------------------------------------------------------------------------
// Exported types (inferred from schema — use these everywhere, not hand-written interfaces)
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
export type CostRecord        = InferSelectModel<typeof costRecords>
export type NewCostRecord     = InferInsertModel<typeof costRecords>

export const SCHEMA_VERSION = '1.0.0'
