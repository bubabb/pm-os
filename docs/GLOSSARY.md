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
