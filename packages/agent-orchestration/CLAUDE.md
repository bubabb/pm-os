# Domain: Agent Orchestration
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Domain Does
The core differentiator of Pm.Os. Replaces flat backlogs with a DAG-based task engine where agents are first-class executors. Manages agent workspaces, execution lifecycle, approval gates, and cost guardrails.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/agent-orchestration/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema (read-only)
- `packages/shared/src/**` — shared types
- `packages/ai-sdk/src/index.ts` — AI execution interface

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- DAG task engine (nodes, edges, execution state)
- Persistent warm agent workspaces (sub-5s spin-up)
- Multi-agent parallel coordination
- Human-agent approval gates
- Agent permission scoping (bounded tool/repo/secret access)
- Rate limiting and cost guardrails per agent
- Agent SLA/SLO tracking (latency, error rate, cost)

## Design Principles
- Agents are first-class — DAG nodes can be assigned to agents or humans
- Every agent action emits an event to the append-only log (never silent mutations)
- Approval gates are blocking — execution pauses until a human approves
- Permissions are deny-by-default — agents get only what's explicitly granted

## Do Not Build
- UI components (belongs in apps/desktop)
- Database migrations (belongs in packages/database)
- Model API calls (belongs in packages/ai-sdk)
