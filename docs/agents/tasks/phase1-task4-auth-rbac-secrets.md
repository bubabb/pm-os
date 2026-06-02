# Agent Task: Phase 1 — Auth, RBAC & Secrets Management (Task #4)
---
status: ready
phase: 1
task-id: 4
blocked-by: [1, 2, 3, 16, 19]
---

## Before You Start
Read in order:
1. `/project-scope.md` §2 (problem statement), §7 (design principles)
2. `/docs/GLOSSARY.md`
3. `/docs/agents/AGENT-PROTOCOL.md`
4. `/packages/database/src/schema.ts` — focus on `users`, `secrets`, `agentWorkspaces` tables
5. `/packages/database/CLAUDE.md`

---

## Your Scope
You own: `apps/desktop/src/main/auth/` and `apps/desktop/src/main/secrets/`

Do not touch:
- `packages/database/src/schema.ts` (read-only)
- Any renderer files in `apps/desktop/src/renderer/`
- Any domain packages in `packages/`

---

## Context: What Exists
- Full monorepo scaffold with Electron + Fastify + SQLite
- `packages/database/src/schema.ts` — `users` and `secrets` tables defined
- `packages/database/src/client.ts` — `getDb()` singleton
- `packages/shared/src/id.ts` — `generateId()` for UUIDs
- Fastify is installed in `apps/desktop/package.json` but not yet started

---

## What You Must Produce

### 1. Drizzle migrations for users and secrets tables
Generate via `pnpm --filter @creare/database run db:generate` after any schema changes.
Migrations live in `packages/database/src/migrations/`.

### 2. Auth service (`apps/desktop/src/main/auth/auth-service.ts`)
- GitHub OAuth 2.0 flow (primary auth method for v1)
- Microsoft Entra SSO (enterprise users)
- Session management using signed JWT tokens stored in Electron's `safeStorage`
- `getCurrentUser(): Promise<User | null>`
- `signIn(provider: 'github' | 'entra'): Promise<User>`
- `signOut(): Promise<void>`

### 3. Auth middleware for Fastify (`apps/desktop/src/main/auth/auth-middleware.ts`)
- `requireAuth` — rejects unauthenticated requests with 401
- `requireRole(role: UserRole)` — rejects insufficient permissions with 403
- Attach `request.user: User` on authenticated requests

### 4. Secrets service (`apps/desktop/src/main/secrets/secrets-service.ts`)
- `encryptSecret(value: string): { encryptedValue: string, iv: string }`
- `decryptSecret(encryptedValue: string, iv: string): string`
- Uses AES-256-GCM. The `iv` is a random 12-byte buffer, base64-encoded. Never reuse IVs.
- Encryption key derived from a machine-specific key stored in Electron `safeStorage`
- `createSecret(projectId: string, name: string, value: string): Promise<Secret>`
- `getSecretValue(secretId: string): Promise<string>` — decrypts and returns plaintext
- `listSecrets(projectId: string): Promise<Array<Omit<Secret, 'encryptedValue' | 'iv'>>>`

### 5. Agent permission validator (`apps/desktop/src/main/auth/agent-permissions.ts`)
- `validateAgentPermission(workspace: AgentWorkspace, resource: 'tool' | 'repo' | 'secret', resourceId: string): boolean`
- Parses `workspace.permissionScope` JSON: `{ tools: string[], repos: string[], secrets: string[] }`
- Returns false if resource not in scope — agents are deny-by-default

---

## Interface Contract (What Task #5 Needs From You)
Export from `apps/desktop/src/main/auth/index.ts`:
```typescript
export { requireAuth, requireRole } from './auth-middleware'
export { getCurrentUser, signIn, signOut } from './auth-service'
export type { AuthenticatedRequest } from './auth-middleware'
```

Export from `apps/desktop/src/main/secrets/index.ts`:
```typescript
export { createSecret, getSecretValue, listSecrets } from './secrets-service'
```

---

## Done When
- [ ] Drizzle migrations generated for users and secrets tables
- [ ] `requireAuth` middleware rejects unauthenticated requests with 401
- [ ] `requireRole` middleware rejects insufficient roles with 403
- [ ] AES-256-GCM encrypt/decrypt round-trips correctly (unit tested)
- [ ] `getSecretValue` decrypts secrets stored with their IV
- [ ] `validateAgentPermission` returns false for out-of-scope resources
- [ ] TypeScript compiles with zero errors
- [ ] All tests pass
- [ ] Handoff file written to `agent-state/handoffs/phase1-task4-output.md`
- [ ] `agent-state/agent-log.md` updated
- [ ] Session log written to `docs/sessions/`
