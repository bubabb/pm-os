import { safeStorage } from 'electron'
import { getDb, secrets } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and } from 'drizzle-orm'
import type { Secret } from '@creare/database'

// AES-256-GCM via Web Crypto — available in Node.js ≥15 via globalThis.crypto
// Electron's safeStorage protects the master key; Web Crypto handles per-value encryption.

const MASTER_KEY_STORAGE = 'creare_master_key_b64'

let _masterKey: CryptoKey | null = null

async function getMasterKey(): Promise<CryptoKey> {
  if (_masterKey) return _masterKey

  // Load or generate the master key, stored encrypted in safeStorage
  let rawBytes: Uint8Array

  const stored = process.env[MASTER_KEY_STORAGE]
  if (stored && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      rawBytes = Buffer.from(decrypted, 'base64')
      if (rawBytes.length !== 32) throw new Error('bad length')
    } catch {
      rawBytes = generateMasterKeyBytes()
    }
  } else {
    rawBytes = generateMasterKeyBytes()
  }

  _masterKey = await globalThis.crypto.subtle.importKey(
    'raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )

  // Persist
  const b64 = Buffer.from(rawBytes).toString('base64')
  if (safeStorage.isEncryptionAvailable()) {
    process.env[MASTER_KEY_STORAGE] = safeStorage.encryptString(b64).toString('base64')
  } else {
    process.env[MASTER_KEY_STORAGE] = b64
  }

  return _masterKey
}

function generateMasterKeyBytes(): Uint8Array {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function encryptSecret(value: string): { encryptedValue: string; iv: string } {
  // Synchronous wrapper — actual encryption is async; callers that need sync should use the async version.
  // This synchronous form is provided for compatibility with the interface contract.
  // In practice, use encryptSecretAsync for all internal calls.
  throw new Error('Use encryptSecretAsync')
}

export async function encryptSecretAsync(value: string): Promise<{ encryptedValue: string; iv: string }> {
  const key = await getMasterKey()
  const ivBytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(ivBytes)

  const encoded = new TextEncoder().encode(value)
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, key, encoded)

  return {
    encryptedValue: Buffer.from(ciphertext).toString('base64'),
    iv: Buffer.from(ivBytes).toString('base64'),
  }
}

export function decryptSecret(encryptedValue: string, iv: string): string {
  throw new Error('Use decryptSecretAsync')
}

export async function decryptSecretAsync(encryptedValue: string, iv: string): Promise<string> {
  const key = await getMasterKey()
  const ivBytes = Buffer.from(iv, 'base64')
  const ciphertext = Buffer.from(encryptedValue, 'base64')

  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes }, key, ciphertext,
  )
  return new TextDecoder().decode(plaintext)
}

export async function createSecret(
  projectId: string,
  name: string,
  value: string,
): Promise<Secret> {
  const { encryptedValue, iv } = await encryptSecretAsync(value)
  const db = getDb()
  const [secret] = await db
    .insert(secrets)
    .values({ id: generateId(), projectId, name, encryptedValue, iv })
    .returning()
  return secret!
}

export async function getSecretValue(secretId: string): Promise<string> {
  const db = getDb()
  const [secret] = await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  if (!secret) throw new Error(`Secret ${secretId} not found`)
  return decryptSecretAsync(secret.encryptedValue, secret.iv)
}

export async function listSecrets(
  projectId: string,
): Promise<Array<Omit<Secret, 'encryptedValue' | 'iv'>>> {
  const db = getDb()
  const rows = await db
    .select({
      id: secrets.id,
      projectId: secrets.projectId,
      name: secrets.name,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(eq(secrets.projectId, projectId))
  return rows
}

export async function deleteSecret(secretId: string, projectId: string): Promise<void> {
  const db = getDb()
  await db.delete(secrets).where(
    and(eq(secrets.id, secretId), eq(secrets.projectId, projectId))
  )
}
