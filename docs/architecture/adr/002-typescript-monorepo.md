# ADR 002 — TypeScript Monorepo with Turborepo + pnpm
---
status: accepted
date: 2026-06-02
---

## Context
5 domain packages + 2 shared packages + 1 Electron app need to share types, build in parallel, and be developed by separate agents without cross-contamination.

## Decision
TypeScript everywhere. Turborepo for build orchestration. pnpm workspaces for package management.

## Alternatives Considered
- **Nx:** More opinionated, heavier setup. Turborepo is simpler for this use case.
- **Lerna:** Largely superseded by Turborepo + pnpm for this pattern.
- **Separate repos:** Cross-domain type sharing becomes painful. Defeats the purpose of a unified platform.

## Consequences
- All packages share `tsconfig.base.json` — consistent strict TypeScript everywhere
- Turborepo caches build outputs — fast incremental builds
- Each agent works in an isolated package — no accidental cross-domain edits
- `@creare/shared` is the single source of truth for cross-domain types
