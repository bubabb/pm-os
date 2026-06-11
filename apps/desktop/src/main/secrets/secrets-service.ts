import { safeStorage } from 'electron'
import { getDb, secrets } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq, and } from 'drizzle-orm'
import { readKeysFile, writeKeysFile } from '../auth/auth-service'
import type { Secret } from '@creare/database'

// AES-256-GCM via Web Crypto (Node.js ≥15, globalThis.crypto).
// Master key is persisted encrypted in ~/.creare/keys.json via safeStorage.
// On first boot a new key is generated and written to disk.

let _masterKey: CryptoKey | null = null

// Load the stable master-key bytes, or create them once. The key NEVER rotates once
// written: a transient OS-keyring failure can no longer regenerate it and orphan every
// encrypted secret. The key lives base64 in the 0600 keys.json (stability-over-at-rest-
// secrecy, deliberate for a local-first single-user app); see KeysFile in auth-service.
function loadOrCreateMasterKeyBytes(): Uint8Array {
  const keys = readKeysFile()

  // 1. Stable raw key — the source of truth once written. Used forever after.
  if (keys.masterKeyRaw) {
    const buf = Buffer.from(keys.masterKeyRaw, 'base64')
    if (buf.length === 32) return new Uint8Array(buf)
  }

  // 2. Legacy keyring-wrapped key — migrate the SAME key to stable raw storage. This
  //    preserves every existing encrypted secret (it's the same key, just stored so a
  //    keyring hiccup can't lose it).
  if (keys.masterKeyBlob && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(keys.masterKeyBlob, 'base64'))
      const candidate = Buffer.from(decrypted, 'base64')
      if (candidate.length === 32) {
        writeKeysFile({ masterKeyRaw: candidate.toString('base64') })
        return new Uint8Array(candidate)
      }
    } catch {
      // fall through to generate — no recoverable key (prior secrets are already lost)
    }
  }

  // 3. No recoverable key — generate ONCE and persist raw (stable forever after).
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  writeKeysFile({ masterKeyRaw: Buffer.from(bytes).toString('base64') })
  return bytes
}

async function getMasterKey(): Promise<CryptoKey> {
  if (_masterKey) return _masterKey
  _masterKey = await globalThis.crypto.subtle.importKey(
    'raw', loadOrCreateMasterKeyBytes(), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
  return _masterKey
}

export async function encryptSecretAsync(value: string): Promise<{ encryptedValue: string; iv: string }> {
  const key = await getMasterKey()
  const ivBytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(ivBytes)

  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    new TextEncoder().encode(value),
  )

  return {
    encryptedValue: Buffer.from(ciphertext).toString('base64'),
    iv: Buffer.from(ivBytes).toString('base64'),
  }
}

export async function decryptSecretAsync(encryptedValue: string, iv: string): Promise<string> {
  const key = await getMasterKey()
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
    key,
    Buffer.from(encryptedValue, 'base64'),
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
  return db
    .select({
      id: secrets.id,
      projectId: secrets.projectId,
      name: secrets.name,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(eq(secrets.projectId, projectId))
}

export async function deleteSecret(secretId: string, projectId: string): Promise<void> {
  const db = getDb()
  await db.delete(secrets).where(
    and(eq(secrets.id, secretId), eq(secrets.projectId, projectId))
  )
}
