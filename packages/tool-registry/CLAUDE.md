# Domain: Tool Registry
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Domain Does
The npm for AI tools. Every AI tool built on Creare is versioned, tested, deployed, and discoverable as a first-class artifact — not an invisible script.

## Your Task Instructions
Read `/docs/agents/tasks/` for the specific task file assigned to this session.

## Files You Own
- `packages/tool-registry/src/**`

## Files You Read (Never Edit)
- `packages/database/src/schema.ts` — DB schema (read-only)
- `packages/shared/src/**` — shared types

## Interface Contract
See `CONTRACT.md` in this directory.

## Key Features to Build (Phase 2)
- Tool versioning and publishing workflow
- Artifact storage and retrieval
- Tool discovery and search
- Dependency graph between tools
- Compatibility checks across model versions
- One-click rollback to any previous version
- Tool usage analytics and performance history

## Design Principles
- Tools are immutable once published — new versions create new records, never overwrite
- Every publish emits an event to the append-only log
- Rollback is a new deployment pointing at an old version — never destructive

## Do Not Build
- UI components (belongs in apps/desktop)
- Agent execution (belongs in packages/agent-orchestration)
- Model API calls (belongs in packages/ai-sdk)
