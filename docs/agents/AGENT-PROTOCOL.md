# Pm.Os — Agent Protocol
---
status: active
version: 1.0
last-updated: 2026-06-02
---

Every agent working on Pm.Os must follow this protocol. No exceptions.

---

## 1. Before Starting Any Task

Read in this order:
1. `/project-scope.md` — master reference, especially §7 Design Principles
2. `/docs/GLOSSARY.md` — canonical term definitions
3. This file (AGENT-PROTOCOL.md)
4. The specific task file in `/docs/agents/tasks/[your-task].md`
5. The `CLAUDE.md` for your domain package
6. The `CONTRACT.md` for your domain package

Do not write a single line of code until all five are read.

---

## 2. File Ownership Rules

- **You own your domain package only** — `packages/[your-domain]/src/**`
- **Never edit files outside your domain** without explicit instructions
- **Read-only files** (never edit, never delete):
  - `project-scope.md`
  - `docs/GLOSSARY.md`
  - `docs/agents/AGENT-PROTOCOL.md`
  - `packages/database/src/schema.ts` (read only — database agent owns this)
  - Any other domain's `CONTRACT.md`

---

## 3. Naming Conventions

- **Files:** `kebab-case.ts`
- **Types/Interfaces:** `PascalCase`
- **Functions/Variables:** `camelCase`
- **Constants:** `SCREAMING_SNAKE_CASE`
- **IDs:** always UUID v4 via `generateId()` from `@pm-os/shared`
- **Package names:** `@pm-os/[domain-name]`

---

## 4. Append-Only Tables Rule

Three tables in Pm.Os are append-only. **Never UPDATE or DELETE from any of them:**
- `events` — platform-wide event log (every domain writes here)
- `trace_events` — individual steps within a trace (observability domain)
- `audit_log` — compliance authorization record (observability domain)

For the `events` table specifically: every domain state change must emit an event here.
- Use `INSERT` only
- Full event shape: `{ id, type, domain, projectId, actorType, actorId, resourceType, resourceId, payload, createdAt }`
- If your action doesn't emit an event, it's not observable — reject it

---

## 5. Done Criteria

A task is complete when ALL of the following are true:
- [ ] All files listed in "What You Must Produce" exist
- [ ] TypeScript compiles with zero errors (`tsc --noEmit`)
- [ ] All tests pass (`vitest run`)
- [ ] No `any` types introduced
- [ ] `CONTRACT.md` updated if public API changed
- [ ] Handoff file written to `agent-state/handoffs/[task-name]-output.md`
- [ ] `agent-state/agent-log.md` updated with a summary entry
- [ ] Session log written to `docs/sessions/[date]-[task].md`

Do not mark a task complete unless every box is checked.

---

## 6. Failure Protocol

If you cannot complete a task:
1. **Do not delete or revert** work already done
2. Write a handoff file with status `FAILED`:
   - What was completed before failure
   - What was not completed and why
   - What the next agent needs to resolve
3. Update `agent-state/agent-log.md` with a FAILED entry
4. Write a session log documenting the failure

---

## 7. Parallel Agent Rules

When multiple domain agents run simultaneously (Phase 2):
- Write only to your own `agent-state/domain-state/[your-domain].md`
- Never write to `agent-state/agent-log.md` while another agent is mid-write — append a timestamped entry
- If you need something from another domain that isn't in its CONTRACT.md, write a blocking question to your domain-state file and halt

---

## 8. Scope Change Rule

Before starting work, check `project-scope.md` for the changelog section.
If the scope changed after your task was created, re-read the affected sections before proceeding.

---

## 9. Read-Only After Approval

`project-scope.md` is read-only once a phase begins. If you discover a scope conflict, document it in your session log and flag it — do not silently change scope.

---

## 10. Cross-Domain API Rule

Any data structure used by more than one domain must be defined in:
- `packages/shared/src/types.ts` (shared types)
- OR `packages/database/src/schema.ts` (DB schema)

Never define the same shape in two different domain packages.
