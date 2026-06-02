# Domain: Boards
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Domain Does
The Azure DevOps replacement layer for Creare. Agent-aware project planning — Kanban, Scrum, Gantt, dependency mapping, portfolio roadmaps, and capacity planning. Unlike Azure Boards, tasks here can be assigned to and executed by agents.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/boards/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema
- `packages/shared/src/**` — shared types
- `packages/agent-orchestration/CONTRACT.md` — agent task interface

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- Kanban and Scrum boards with customizable workflows
- Native Gantt / timeline view
- Dependency mapping (tasks, milestones, agents)
- Portfolio roadmap across projects
- Resource and agent capacity planning
- Critical path analysis
- Milestone tracking
- What-if scenario planning
- Multi-project workspace management

## Design Principles
- Board items (tasks) are linked to DAG nodes in agent-orchestration — not duplicated
- Every board state change emits an event to the append-only log
- Agent-assigned tasks show execution status live via SSE

## Do Not Build
- UI components (belongs in apps/desktop)
- Agent execution (belongs in packages/agent-orchestration)
