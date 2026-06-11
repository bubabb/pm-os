import {
  getDb,
  integrationCredentials,
  integrationSyncState,
  externalEventCache,
  remoteLinks,
  mutationQueue,
  syncConflicts,
} from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and, inArray } from 'drizzle-orm'
import { decryptSecretAsync } from './secrets-service'
import { getConnection } from './connections-service'
import type { IntegrationCredential } from '@creare/database'

// A per-project SOURCE: binds a project to a global connection plus a resource
// scope (e.g. { owner, repo } for GitHub, { projectKey } for Jira). The user never
// enters a token here — we copy the connection's ciphertext (encryptedToken + iv)
// verbatim, so getIntegrationToken keeps decrypting the row's own copy unchanged.
export async function storeIntegrationCredential(input: {
  projectId: string
  source: IntegrationCredential['source']
  connectionId: string
  label: string
  metadata?: Record<string, unknown>
}): Promise<IntegrationCredential> {
  const connection = await getConnection(input.connectionId)
  if (!connection) throw new Error(`Connection ${input.connectionId} not found`)

  const db = getDb()
  const [credential] = await db
    .insert(integrationCredentials)
    .values({
      id: generateId(),
      projectId: input.projectId,
      source: connection.source,
      label: input.label,
      connectionId: connection.id,
      encryptedToken: connection.encryptedToken,
      iv: connection.iv,
      metadata: JSON.stringify(input.metadata ?? {}), // per-project resource scope
      expiresAt: connection.expiresAt,
    })
    .returning()
  return credential!
}

// Re-copies a connection's current ciphertext into every linked source row.
// Call after a connection token rotation so all per-project copies stay valid.
export async function propagateConnectionToken(connectionId: string): Promise<void> {
  const connection = await getConnection(connectionId)
  if (!connection) throw new Error(`Connection ${connectionId} not found`)

  const db = getDb()
  await db
    .update(integrationCredentials)
    .set({
      encryptedToken: connection.encryptedToken,
      iv: connection.iv,
      expiresAt: connection.expiresAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(integrationCredentials.connectionId, connectionId))
}

// For sync: merges the connection's account-level metadata (baseUrl, email, …)
// with the source's per-project resource scope ({ owner, repo } / { projectKey } / …)
// so the connector sees both. Returns a SHALLOW CLONE — never mutates the row.
// Legacy rows without a connectionId pass through unchanged.
export async function withMergedConnectionMetadata(
  credential: IntegrationCredential,
): Promise<IntegrationCredential> {
  if (!credential.connectionId) return credential
  const connection = await getConnection(credential.connectionId)
  if (!connection) return credential

  const parse = (raw: string): Record<string, unknown> => {
    try { return JSON.parse(raw) as Record<string, unknown> }
    catch { return {} }
  }
  const accountMeta = parse(connection.metadata)
  const scopeMeta = parse(credential.metadata)
  return { ...credential, metadata: JSON.stringify({ ...accountMeta, ...scopeMeta }) }
}

// Returns the plaintext OAuth token. Never log or expose the return value.
export async function getIntegrationToken(credentialId: string): Promise<string> {
  const db = getDb()
  const [cred] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId))
    .limit(1)
  if (!cred) throw new Error(`Integration credential ${credentialId} not found`)
  return decryptSecretAsync(cred.encryptedToken, cred.iv)
}

export async function listIntegrationCredentials(
  projectId: string,
): Promise<Array<Omit<IntegrationCredential, 'encryptedToken' | 'iv'>>> {
  const db = getDb()
  const rows = await db
    .select({
      id: integrationCredentials.id,
      projectId: integrationCredentials.projectId,
      source: integrationCredentials.source,
      label: integrationCredentials.label,
      metadata: integrationCredentials.metadata,
      expiresAt: integrationCredentials.expiresAt,
      connectionId: integrationCredentials.connectionId,
      createdAt: integrationCredentials.createdAt,
      updatedAt: integrationCredentials.updatedAt,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.projectId, projectId))
  return rows
}

// Hard-deletes a source binding AND every row that references it. With
// foreign_keys=ON and ON DELETE NO ACTION on the referencing tables, a bare
// DELETE on a mirrored credential throws an FK violation and the row becomes
// permanently undeletable — so this is one transaction, children first:
// sync_conflicts (via the credential's links + mutations) → mutation_queue →
// remote_links → sync state / event cache → the credential itself. Hard
// delete is correct: the user is removing the source, tombstones included.
export async function deleteIntegrationCredential(credentialId: string): Promise<void> {
  const db = getDb()
  db.transaction((tx) => {
    // Conflicts reference remote_links (NOT NULL) and optionally the probing
    // mutation — both must go before their parents.
    const linkIds = tx
      .select({ id: remoteLinks.id })
      .from(remoteLinks)
      .where(eq(remoteLinks.credentialId, credentialId))
      .all()
      .map((row) => row.id)
    if (linkIds.length > 0) {
      tx.delete(syncConflicts).where(inArray(syncConflicts.remoteLinkId, linkIds)).run()
    }
    const mutationIds = tx
      .select({ id: mutationQueue.id })
      .from(mutationQueue)
      .where(eq(mutationQueue.credentialId, credentialId))
      .all()
      .map((row) => row.id)
    if (mutationIds.length > 0) {
      tx.delete(syncConflicts).where(inArray(syncConflicts.mutationId, mutationIds)).run()
    }

    tx.delete(mutationQueue).where(eq(mutationQueue.credentialId, credentialId)).run()
    tx.delete(remoteLinks).where(eq(remoteLinks.credentialId, credentialId)).run()
    tx.delete(integrationSyncState).where(eq(integrationSyncState.credentialId, credentialId)).run()
    tx.delete(externalEventCache).where(eq(externalEventCache.credentialId, credentialId)).run()
    tx.delete(integrationCredentials).where(eq(integrationCredentials.id, credentialId)).run()
  })
}

export function isTokenExpired(credential: Pick<IntegrationCredential, 'expiresAt'>): boolean {
  if (!credential.expiresAt) return false
  return new Date(credential.expiresAt) < new Date()
}

// Updates the per-project scope (metadata) and/or label. Token updates happen on
// the CONNECTION (updateConnection) and propagate via propagateConnectionToken.
export async function updateIntegrationCredential(
  credentialId: string,
  projectId: string,
  updates: { label?: string; metadata?: Record<string, unknown> },
): Promise<IntegrationCredential> {
  const db = getDb()
  const patch: Partial<IntegrationCredential> = { updatedAt: new Date().toISOString() }

  if (updates.label !== undefined) {
    patch.label = updates.label
  }
  if (updates.metadata !== undefined) {
    patch.metadata = JSON.stringify(updates.metadata)
  }

  const [updated] = await db
    .update(integrationCredentials)
    .set(patch)
    .where(and(eq(integrationCredentials.id, credentialId), eq(integrationCredentials.projectId, projectId)))
    .returning()
  if (!updated) throw new Error(`Integration credential ${credentialId} not found`)
  return updated
}
