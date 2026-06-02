# Creare — Data Models
---
status: active
version: 1.0
last-updated: 2026-06-02
---

Canonical reference for all data models. The source of truth is always `packages/database/src/schema.ts` — this document explains the design decisions.

---

## Design Rules (Non-Negotiable)

1. **UUIDs everywhere** — all primary keys are `text` UUID v4 via `globalThis.crypto.randomUUID()`
2. **Append-only tables** — `events`, `trace_events`, `audit_log` are insert-only. No UPDATE or DELETE.
3. **Timestamps as ISO strings** — all dates stored as ISO 8601 text (SQLite has no native date type)
4. **Costs in cents** — all monetary values stored as integer cents to avoid floating point errors
5. **JSON as text** — complex objects (permissionScope, payload, schema) stored as JSON text columns

---

## Table Map

### 1. Identity
| Table | Purpose |
|---|---|
| `users` | All human users of the platform |
| `projects` | Top-level workspace containers |

### 2. Security
| Table | Purpose |
|---|---|
| `secrets` | Encrypted API keys and environment variables, scoped per project |

### 3. Agent Orchestration
| Table | Purpose |
|---|---|
| `agent_workspaces` | Persistent agent environments with model config, permissions, and cost limits |
| `tasks` | DAG nodes — units of work assigned to humans or agents |
| `task_edges` | DAG edges — `fromTaskId` must complete before `toTaskId` can start |
| `approval_gates` | Blocking checkpoints requiring human sign-off before agent continues |

### 4. Tool Registry
| Table | Purpose |
|---|---|
| `tools` | Registered AI tools (the registry entry) |
| `tool_versions` | Immutable published versions of each tool |
| `tool_deployments` | Active deployments, with `previousVersionId` enabling one-click rollback |

### 5. Observability
| Table | Purpose | Append-only? |
|---|---|---|
| `events` | Platform-wide event log — every domain writes here | ✅ Yes |
| `traces` | Agent execution sessions (aggregates token usage, cost, duration) | No |
| `trace_events` | Individual steps within a trace (LLM calls, tool calls, errors) | ✅ Yes |
| `audit_log` | Compliance record — who authorized what, when, for SOC2/HIPAA | ✅ Yes |

### 6. Boards
| Table | Purpose |
|---|---|
| `boards` | Kanban or Scrum boards within a project |
| `board_columns` | Columns within a board (To Do, In Progress, Done, etc.) |
| `sprints` | Time-boxed iterations |
| `board_items` | Links a `task` to a `board` + `column` + optional `sprint` |
| `milestones` | Project milestones with due dates and status |
| `milestone_tasks` | Join table linking tasks to milestones |

### 7. Cross-Cutting
| Table | Purpose |
|---|---|
| `notifications` | In-app alerts for approval gates, agent failures, cost warnings |
| `cost_records` | Per-call AI model usage and spend, linked to traces |

---

## Key Design Decisions

### Tasks vs Board Items
A `task` is the unit of work (what needs to be done).
A `board_item` is how that task appears on a board (where it sits, what sprint, what story points).
This separation means a task can exist without a board, and future multi-board support requires no schema change.

### Events vs Audit Log
- `events` = technical observability (what happened in the system)
- `audit_log` = compliance authorization record (who approved what)
These serve different audiences and must not be merged.

### Tool Versions are Immutable
Once a `tool_version` is published, it is never modified.
Rollback works by creating a new `tool_deployment` pointing at an older `tool_version`.

### Costs in Cents
`costCents` columns store values as integer cents (1 USD = 100 cents).
This prevents floating point precision errors in cost calculations and aggregations.

### Agent Permissions as JSON
`agentWorkspaces.permissionScope` is stored as a JSON text column.
Shape: `{ tools: string[], repos: string[], secrets: string[] }`.
This is intentionally flexible for Phase 2 implementation.
