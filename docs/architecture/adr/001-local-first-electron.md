# ADR 001 — Local-First Electron Desktop App
---
status: superseded
date: 2026-06-02
superseded: 2026-07-06
---

> **SUPERSEDED (2026-07-06):** Electron was removed. Pm.Os is now headless-only — a
> Fastify localhost API serving a React SPA as a local web app, plus a CLI (run with
> `pnpm pm-os`). The local-first / offline / single-user principles below still hold;
> only the Electron shell is gone. The rest of this ADR is kept as a historical record.

## Context
Pm.Os needs to run locally for a single user in v1, with a path to team collaboration in v2 without a rewrite.

## Decision
Build as an Electron desktop app with embedded SQLite. Local HTTP server (Fastify on localhost) from day one for web-compatibility in v2.

## Alternatives Considered
- **Docker Compose:** Requires Docker installed. Non-technical stakeholders (PMs, execs) are first-class users — this blocks adoption.
- **CLI + local web server:** No persistent services, harder to manage multi-domain architecture.
- **Cloud SaaS:** Conflicts with local-first requirement and data privacy needs.

## Consequences
- Single installable, no dependencies, fully offline
- HTTP from day 1 means frontend code is transport-agnostic — web version in v2 requires no frontend changes
- v2 team sync via ElectricSQL (SQLite → Postgres) — no schema rewrite needed

## Sync-Readiness Constraints Enforced
- UUIDs everywhere (no auto-increment)
- Append-only event log
- Conflict-aware data models
