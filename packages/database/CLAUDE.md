# Package: Database
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Package Does
The single source of truth for all data in Creare. SQLite + Drizzle ORM. Owns all schema definitions, migrations, and the append-only event log. Every domain reads and writes through this package.

## Critical Rules
- **schema.ts is the law** — all domains use these types. Never define competing types.
- **UUIDs everywhere** — all primary keys are UUIDs, never auto-increment integers
- **Append-only event log** — the `events` table is insert-only. No updates. No deletes. Ever.
- **Migrations are additive** — never drop columns or tables in production migrations

## Files You Own
- `packages/database/src/**`

## Consumed By
Every other package and the desktop app.
