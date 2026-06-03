import { getDb, integrationCredentials } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and } from 'drizzle-orm'
import { encryptSecretAsync, decryptSecretAsync } from './secrets-service'
import type { IntegrationCredential } from '@creare/database'

export async function storeIntegrationCredential(input: {
  projectId: string
  source: IntegrationCredential['source']
  label: string
  token: string
  metadata?: Record<string, unknown>
  expiresAt?: string
}): Promise<IntegrationCredential> {
  const { encryptedValue, iv } = await encryptSecretAsync(input.token)
  const db = getDb()
  const [credential] = await db
    .insert(integrationCredentials)
    .values({
      id: generateId(),
      projectId: input.projectId,
      source: input.source,
      label: input.label,
      encryptedToken: encryptedValue,
      iv,
      metadata: JSON.stringify(input.metadata ?? {}),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
  return credential!
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
      createdAt: integrationCredentials.createdAt,
      updatedAt: integrationCredentials.updatedAt,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.projectId, projectId))
  return rows
}

export async function deleteIntegrationCredential(credentialId: string): Promise<void> {
  const db = getDb()
  await db.delete(integrationCredentials).where(eq(integrationCredentials.id, credentialId))
}

export function isTokenExpired(credential: Pick<IntegrationCredential, 'expiresAt'>): boolean {
  if (!credential.expiresAt) return false
  return new Date(credential.expiresAt) < new Date()
}

export async function updateIntegrationCredential(
  credentialId: string,
  projectId: string,
  updates: { token?: string; metadata?: Record<string, unknown>; expiresAt?: string | null },
): Promise<IntegrationCredential> {
  const db = getDb()
  const patch: Partial<IntegrationCredential> = { updatedAt: new Date().toISOString() }

  if (updates.token !== undefined) {
    const { encryptedValue, iv } = await encryptSecretAsync(updates.token)
    patch.encryptedToken = encryptedValue
    patch.iv = iv
  }
  if (updates.metadata !== undefined) {
    patch.metadata = JSON.stringify(updates.metadata)
  }
  if (updates.expiresAt !== undefined) {
    patch.expiresAt = updates.expiresAt
  }

  const [updated] = await db
    .update(integrationCredentials)
    .set(patch)
    .where(and(eq(integrationCredentials.id, credentialId), eq(integrationCredentials.projectId, projectId)))
    .returning()
  if (!updated) throw new Error(`Integration credential ${credentialId} not found`)
  return updated
}
