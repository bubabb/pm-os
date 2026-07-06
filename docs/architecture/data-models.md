# Pm.Os — Data Models
---
status: active
version: 1.2
last-updated: 2026-06-03
---

Canonical reference for all data models. The source of truth is always `packages/database/src/schema.ts` — this document explains the design decisions.

---

## Design Rules (Non-Negotiable)

1. **UUIDs everywhere** — all primary keys are `text` UUID v4 via `globalThis.crypto.randomUUID()`
2. **Append-only tables** — `events`, `trace_events`, `audit_log` are insert-only. No UPDATE or DELETE. Ever.
3. **Timestamps as ISO strings** — all dates stored as ISO 8601 text (SQLite has no native date type)
4. **Costs in cents** — all monetary values stored as integer cents to avoid floating point errors
5. **JSON as text** — complex objects (permissionScope, payload, schema) stored as JSON text columns
6. **Encryption requires IV** — `secrets.encryptedValue` (AES-256-GCM ciphertext) is always paired with `secrets.iv` (random 12-byte IV, base64). Never store ciphertext without its IV.

---

## Table Map

### 1. Identity
| Table | Purpose |
|---|---|
| `users` | All human users of the platform |
| `projects` | Top-level workspace containers. `archivedAt` enables soft archive. |

### 2. Security
| Table | Purpose |
|---|---|
| `secrets` | Encrypted API keys and env vars, scoped per project. `encryptedValue` = AES-256-GCM ciphertext. `iv` = base64 initialization vector (unique per encryption, required for decryption). |

### 3. Agent Orchestration
| Table | Purpose |
|---|---|
| `agent_workspaces` | Persistent agent environments. `permissionScope` JSON: `{ tools, repos, secrets }`. `tokensResetDate` tracks daily counter reset boundary. `dailyCostLimitCents` + `costUsedTodayCents` enforce spend guardrails. |
| `tasks` | DAG nodes — units of work assigned to humans or agents |
| `task_edges` | DAG edges — `fromTaskId` must complete before `toTaskId` starts. Unique constraint on `(fromTaskId, toTaskId)`. **Application must detect cycles before inserting.** |
| `approval_gates` | Blocking checkpoints requiring human sign-off |

### 4. Tool Registry
| Table | Purpose |
|---|---|
| `tools` | Registered AI tools. `latestVersionId` FK points at current active version (nullable until first publish). |
| `tool_versions` | Immutable published versions. Once inserted, never modified. |
| `tool_deployments` | Active deployments. `previousVersionId` populated on rollback — rollback = new deployment pointing at old version. |

### 5. Observability
| Table | Purpose | Append-only? |
|---|---|---|
| `events` | Platform-wide event log — every domain writes here | ✅ Yes |
| `traces` | Agent execution sessions (token usage, cost, duration) | No |
| `trace_events` | Individual steps within a trace (LLM calls, tool calls, errors) | ✅ Yes |
| `audit_log` | Compliance record — who authorized what, when, for SOC2/HIPAA | ✅ Yes |

### 6. Boards
| Table | Purpose |
|---|---|
| `boards` | Kanban or Scrum boards |
| `board_columns` | Columns within a board. `isTerminal = true` means items here are done. `wipLimit` enforces work-in-progress caps. |
| `sprints` | Time-boxed iterations. `velocity` = story points completed (set at completion). |
| `board_items` | Links a `task` to a `board` + `column` + optional `sprint`. `position` = integer ordering. |
| `milestones` | Due-date checkpoints with `at_risk` detection. |
| `milestone_tasks` | Join table. Unique constraint on `(milestoneId, taskId)`. |

### 7. Integrations
| Table | Purpose |
|---|---|
| `integration_credentials` | OAuth tokens and PATs for external sources (Jira, GitHub, Confluence, Notion, OneDrive). Encrypted identically to `secrets` — AES-256-GCM ciphertext + IV pair. `metadata` JSON carries source-specific config (baseUrl, accountId, scopes). `expiresAt` is null for non-expiring PATs. |
| `integration_sync_state` | Last sync cursor and health status per credential. `syncCursor` is a source-specific pagination token or etag — null means a full resync is needed. |
| `external_event_cache` | Normalized external events from all sources. Append-only: new fetch = new row. TTL purging via `purgedAt` soft-delete — never hard DELETE. Active records: `WHERE purgedAt IS NULL`. |
| `pm_digest_cache` | AI-generated digest snapshots per zone (morning_brief, sprint_health, decisions_and_docs, risk_radar). Dashboard reads here first; regenerates if `validUntil` has passed. |
| `user_settings` | PM-configurable delegation rules and dashboard preferences, stored as key-value pairs per user per project. `key` uses dot-notation (e.g. `pm.delegation.auto_approve_doc_updates`). `value` is always JSON-encoded. |

### 8. Cross-Cutting
| Table | Purpose |
|---|---|
| `notifications` | In-app alerts. `readAt` is null until read. Index on `(userId, readAt)` powers unread count badge. |
| `cost_records` | Per-API-call spend tracking. All values in cents. Linked to trace and workspace. |

---

## Indexes

| Index | Table | Columns | Query It Serves |
|---|---|---|---|
| `events_project_created_idx` | events | `(projectId, createdAt)` | Timeline queries per project |
| `events_domain_type_idx` | events | `(domain, type)` | Domain-specific event filtering |
| `events_resource_idx` | events | `(resourceType, resourceId)` | "Show all events for task X" |
| `tasks_project_status_idx` | tasks | `(projectId, status)` | Board column queries |
| `tasks_project_priority_idx` | tasks | `(projectId, priority)` | Priority-sorted backlogs |
| `traces_workspace_started_idx` | traces | `(agentWorkspaceId, startedAt)` | Agent performance history |
| `traces_project_status_idx` | traces | `(projectId, status)` | Running traces dashboard |
| `notifications_user_read_idx` | notifications | `(userId, readAt)` | Unread count badge |
| `task_edges_unique_edge_idx` | task_edges | `(fromTaskId, toTaskId)` | Prevents duplicate DAG edges |
| `milestone_tasks_unique_idx` | milestone_tasks | `(milestoneId, taskId)` | Prevents duplicate task-milestone links |
| `integration_credentials_project_source_idx` | integration_credentials | `(projectId, source)` | "Which credentials does this project have for Jira?" |
| `ext_cache_source_entity_idx` | external_event_cache | `(source, entityType, entityId)` | Cross-source entity correlation (Jira ↔ GitHub ticket ID matching) |
| `ext_cache_project_fetched_idx` | external_event_cache | `(projectId, fetchedAt)` | Dashboard load — fetch latest events per project |
| `user_settings_unique_idx` | user_settings | `(userId, projectId, key)` | Unique constraint + lookup for per-user PM settings |

---

## Key Design Decisions

### Tasks vs Board Items
A `task` is the unit of work (what needs to be done). A `board_item` is how that task appears on a board (where it sits, what sprint, what story points). A task can exist without a board. Multi-board support requires no schema change.

### Events vs Audit Log
- `events` = technical observability (what happened in the system, for replaying and tracing)
- `audit_log` = compliance authorization record (who approved what, for SOC2/HIPAA)
These serve different audiences and must not be merged.

### Tool Versions are Immutable
Once a `tool_version` is published, it is never modified. Rollback = new `tool_deployment` pointing at an older `tool_version`.

### Cycle Detection is Application-Level
SQLite cannot enforce DAG acyclicity. The agent-orchestration domain must check for cycles before inserting any `task_edge`. See `packages/agent-orchestration/CLAUDE.md`.

### Daily Cost Counter Reset
`agentWorkspaces.tokensResetDate` stores the ISO date string of the last reset. Before incrementing daily counters, compare current date to `tokensResetDate`. If different, reset counters and update `tokensResetDate`.
