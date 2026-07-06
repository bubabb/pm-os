# ADR 001 — Local-First Electron Desktop App
---
status: accepted
date: 2026-06-02
---

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
