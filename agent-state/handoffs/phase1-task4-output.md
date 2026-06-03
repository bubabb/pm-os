# Handoff: Phase 1 Task #4 — Auth, RBAC & Secrets

**Status:** Complete  
**Completed:** 2026-06-03

## What Was Built

### Auth
- `apps/desktop/src/main/auth/auth-service.ts` — `signIn()`, `signOut()`, `getCurrentUser()`, `verifyToken()`. Phase 1 creates a dev user per provider. JWT signed with HS256, 30-day expiry, stored encrypted via `safeStorage`.
- `apps/desktop/src/main/auth/auth-middleware.ts` — `requireAuth` (Fastify preHandler), `requireRole(role)`. Attaches `request.user: User` on success.
- `apps/desktop/src/main/auth/agent-permissions.ts` — `validateAgentPermission()`. Agents are deny-by-default; `'*'` grants wildcard access for a resource type.
- `apps/desktop/src/main/auth/index.ts` — public exports.

### Secrets
- `apps/desktop/src/main/secrets/secrets-service.ts` — AES-256-GCM encrypt/decrypt using Web Crypto (`globalThis.crypto.subtle`). Master key stored encrypted in `safeStorage` via env. `createSecret()`, `getSecretValue()`, `listSecrets()` (no plaintext in response), `deleteSecret()`.
- `apps/desktop/src/main/secrets/integration-credentials-service.ts` — same encryption for OAuth tokens. `storeIntegrationCredential()`, `getIntegrationToken()`, `listIntegrationCredentials()`, `deleteIntegrationCredential()`, `updateIntegrationCredential()`, `isTokenExpired()`.
- `apps/desktop/src/main/secrets/index.ts` — public exports.

## Notes for Task #5
- `requireAuth` and `requireRole` are imported from `../auth`
- `AuthenticatedRequest` type: cast `request as AuthenticatedRequest` to access `.user`
- JWT format: `Bearer <token>` in `Authorization` header
- `/auth/sign-in` route is now in `routes/auth.ts` — issues JWT for renderer

## Notes for Domain 6 (Integrations)
- `getIntegrationToken(credentialId)` returns plaintext — never log it
- `isTokenExpired(credential)` checks `expiresAt` — call before every sync
