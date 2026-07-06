import { getDb, connections, integrationCredentials } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq } from 'drizzle-orm'
import { encryptSecretAsync, decryptSecretAsync } from './secrets-service'
import type { Connection } from '@pm-os/database'

// Workspace-level (GLOBAL) tool connections — not project-scoped.
// Tokens are encrypted with the same AES-256-GCM helpers as `secrets`.

export async function storeConnection(input: {
  source: Connection['source']
  label: string
  token: string
  metadata?: Record<string, unknown>
  expiresAt?: string
}): Promise<Connection> {
  const { encryptedValue, iv } = await encryptSecretAsync(input.token)
  const db = getDb()
  const [connection] = await db
    .insert(connections)
    .values({
      id: generateId(),
      source: input.source,
      label: input.label,
      encryptedToken: encryptedValue,
      iv,
      metadata: JSON.stringify(input.metadata ?? {}),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
  return connection!
}

// Returns the plaintext token. Never log or expose the return value.
export async function getConnectionToken(connectionId: string): Promise<string> {
  const db = getDb()
  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1)
  if (!connection) throw new Error(`Connection ${connectionId} not found`)
  return decryptSecretAsync(connection.encryptedToken, connection.iv)
}

export async function listConnections(): Promise<Array<Omit<Connection, 'encryptedToken' | 'iv'>>> {
  const db = getDb()
  const rows = await db
    .select({
      id: connections.id,
      source: connections.source,
      label: connections.label,
      metadata: connections.metadata,
      expiresAt: connections.expiresAt,
      createdAt: connections.createdAt,
      updatedAt: connections.updatedAt,
    })
    .from(connections)
  return rows
}

export async function getConnection(connectionId: string): Promise<Connection | null> {
  const db = getDb()
  const [connection] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1)
  return connection ?? null
}

export async function updateConnection(
  connectionId: string,
  updates: { label?: string; token?: string; metadata?: Record<string, unknown>; expiresAt?: string | null },
): Promise<Connection> {
  const db = getDb()
  const patch: Partial<Connection> = { updatedAt: new Date().toISOString() }

  if (updates.label !== undefined) {
    patch.label = updates.label
  }
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
    .update(connections)
    .set(patch)
    .where(eq(connections.id, connectionId))
    .returning()
  if (!updated) throw new Error(`Connection ${connectionId} not found`)

  // Token rotated — propagate the new ciphertext to every linked per-project
  // source so getIntegrationToken keeps working on their copies. Done inline
  // (not via propagateConnectionToken) to avoid a circular import with
  // integration-credentials-service.
  if (updates.token !== undefined) {
    await db
      .update(integrationCredentials)
      .set({
        encryptedToken: updated.encryptedToken,
        iv: updated.iv,
        expiresAt: updated.expiresAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(integrationCredentials.connectionId, connectionId))
  }

  return updated
}

export async function deleteConnection(connectionId: string): Promise<void> {
  const db = getDb()
  // Detach linked per-project sources first — keep the source rows and their
  // cached data; they just no longer track a global connection.
  await db
    .update(integrationCredentials)
    .set({ connectionId: null, updatedAt: new Date().toISOString() })
    .where(eq(integrationCredentials.connectionId, connectionId))
  await db.delete(connections).where(eq(connections.id, connectionId))
}
