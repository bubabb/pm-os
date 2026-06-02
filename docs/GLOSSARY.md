# Creare — Canonical Glossary
---
status: active
version: 1.0
last-updated: 2026-06-02
---

All agents and developers must use these definitions consistently.
Adding a new term? Define it here before using it in code.

---

## Core Terms

**Agent**
An AI model instance executing a task within the Creare platform. Agents are assigned to DAG nodes, have bounded permissions, and emit events to the event log. Not the same as a human user.

**Task**
A unit of work in the DAG. Has a type (human | agent), status, dependencies, and an assignee. The fundamental scheduling unit.

**DAG (Directed Acyclic Graph)**
The task execution model in Creare. Tasks are nodes; dependencies are directed edges. Execution flows from root nodes to leaf nodes. Replaces linear backlogs.

**Tool**
A versioned, deployable AI function registered in the Tool Registry. Tools are called by agents during task execution. Not the same as an MCP tool.

**Workspace**
A persistent, warm execution environment for an agent. Pre-loaded with context and tools. Designed for sub-5-second agent activation.

**Event**
An immutable record in the append-only event log. Every state change in Creare produces an event. Events are never updated or deleted.

**Event Log**
The append-only SQLite table that records all state changes across all domains. Powers observability, replay, and future sync.

**Trace**
A technical record of what happened during an agent execution — API calls made, tools invoked, tokens consumed, latency. Part of observability.

**Audit Log**
An immutable authorization record — who approved what, when, and why. Separate from traces. Required for compliance (SOC2, HIPAA).

**Approval Gate**
A blocking checkpoint in a DAG where human sign-off is required before execution continues. Triggers a notification to the assigned approver.

**Handoff**
A structured transfer of context between an agent completing a task and the next agent (or human) picking it up.

**Project**
A top-level workspace containing a DAG, boards, tool registry entries, and reporting. Users manage multiple projects.

**Sprint**
A time-boxed iteration within a project's board. Contains tasks with estimates and acceptance criteria.

**Pipeline**
A sequence of automated steps triggered by an event (e.g., commit, tool publish, deployment). Integrates with external CI/CD via MCP.

**MCP (Model Context Protocol)**
The open protocol used by Creare to connect agents to external tools and services. All external integrations use MCP.

**Model**
An AI language model from any provider (Anthropic Claude, OpenAI GPT, Google Gemini, or open-source). Creare is model-agnostic.

**Domain**
A bounded module in the Creare monorepo (agent-orchestration, tool-registry, observability, boards, reporting). Each domain owns its own data and logic.

**ApprovalGate**
A blocking checkpoint in a DAG task where an agent requests human authorization before continuing. The agent writes a `context` JSON field describing what it wants to do; a human reviewer approves or rejects. Execution is paused until the gate resolves. See `approval_gates` table.

**TraceEvent**
A single step within a Trace — one LLM call, tool invocation, tool result, error, or checkpoint. Stored in the `trace_events` table. Append-only: never updated or deleted. The sequence of trace events forms a replay-able execution history.

**AuditLog**
An immutable compliance record of who authorized what and when. Separate from traces. Written to the `audit_log` table. Required for SOC2/HIPAA. Records the `action` (e.g. `"task.approved"`), the `actorId`, and the affected resource. Never updated or deleted.

**Sprint**
A time-boxed iteration within a Scrum board. Contains board items with story point estimates. Has a `status` lifecycle: `planning → active → completed`. Stores a `velocity` (story points completed) for historical comparison. See `sprints` table.

**Milestone**
A project-level checkpoint with a due date and status (`pending`, `at_risk`, `completed`, `missed`). Tasks are linked to milestones via the `milestone_tasks` join table. Status changes emit events to the event log.

**CostRecord**
A per-call record of AI model API usage. Stores `provider`, `modelId`, `inputTokens`, `outputTokens`, and `costCents` (always integer cents, never floats). Linked to a `Trace` and `AgentWorkspace`. Powers the per-project and per-agent spend dashboards in the Reporting domain.

**Permission Scope**
The JSON field on `AgentWorkspace` that defines what resources an agent is allowed to access. Structure: `{ tools: string[], repos: string[], secrets: string[] }` where each array contains allowed resource IDs. Agents are deny-by-default — if a resource isn't in the scope, the permission check returns false. Validated before every agent action.

**IV (Initialization Vector)**
A random 12-byte value used in AES-256-GCM encryption of secrets. Stored as a base64 string in the `secrets.iv` column. Must be unique per encryption operation — reusing an IV with the same key breaks GCM security. Never reuse. Generated fresh for every `createSecret()` call.
