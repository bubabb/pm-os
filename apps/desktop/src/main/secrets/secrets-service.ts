import { getDb, secrets, connections, globalSettings } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq, and } from 'drizzle-orm'
import { readKeysFile, writeKeysFile } from '../auth/auth-service'
import type { Secret } from '@pm-os/database'

// AES-256-GCM via Web Crypto (Node.js ≥15, globalThis.crypto).
// Master key is a stable raw 32-byte key stored base64 in ~/.pmos/keys.json
// (mode 0600) — see the KeysFile comments in auth-service.ts for the rationale
// (stability over at-rest secrecy; the prior safeStorage-wrapped scheme silently
// destroyed data on any OS-keyring hiccup). On first boot a new key is generated
// and written to disk; it never rotates after that.

let _masterKey: CryptoKey | null = null

/**
 * Thrown when a stored secret (a connector token or the reasoning API key) can't be
 * decrypted — almost always because it was encrypted under a previous master key and
 * is now orphaned. `statusCode` is honored by Fastify's default error handler, so the
 * client gets a clear, actionable 422 instead of a raw 500. 422 (not 401) on purpose:
 * 401 makes the renderer auto-sign-out.
 */
export class CredentialError extends Error {
  readonly statusCode = 422
  readonly code = 'credential_unreadable'
  constructor(message: string) {
    super(message)
    this.name = 'CredentialError'
  }
}

// True when any row encrypted under the master key already exists. Used to detect —
// and loudly report — the data-loss case where a new key is generated while old
// ciphertext is still in the DB (those rows can never be decrypted again).
function encryptedDataExists(): boolean {
  try {
    const db = getDb()
    return (
      db.select({ id: secrets.id }).from(secrets).limit(1).all().length > 0 ||
      db.select({ id: connections.id }).from(connections).limit(1).all().length > 0 ||
      db.select({ id: globalSettings.id }).from(globalSettings).limit(1).all().length > 0
    )
  } catch {
    // DB not initialized / migrated yet — treat as "no encrypted data".
    return false
  }
}

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

  // Legacy data-loss guard: an old keyring-wrapped key exists but there is no raw key.
  // Pm.Os is headless-only (no Electron/OS-keyring), so the blob can no longer be
  // unwrapped, and generating a new key would silently orphan every previously-encrypted
  // secret. Refuse unless the operator opts into discarding it with PMOS_ALLOW_KEY_REGEN=1.
  if (keys.masterKeyBlob && process.env['PMOS_ALLOW_KEY_REGEN'] !== '1') {
    throw new Error(
      '[pm-os] Legacy keyring-wrapped master key found but no raw key, and headless Pm.Os ' +
        'cannot unwrap it. Set PMOS_ALLOW_KEY_REGEN=1 to discard the old key and all encrypted secrets.',
    )
  }

  // 3. No recoverable key — generate ONCE and persist raw (stable forever after).
  //    If ciphertext already exists in the DB, generating a new key orphans it — that
  //    must be loud, never silent (we still generate so the app boots; the alternative
  //    is bricking startup over data that is already unrecoverable).
  if (encryptedDataExists()) {
    console.error(
      '[pm-os] WARNING: generating a new master key while encrypted data exists — previously stored tokens/keys can no longer be decrypted and must be re-entered',
    )
  }
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  writeKeysFile({ masterKeyRaw: Buffer.from(bytes).toString('base64') })
  return bytes
}

async function getMasterKey(): Promise<CryptoKey> {
  if (_masterKey) return _masterKey
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the key data types as a plain
  // BufferSource (the source bytes are Uint8Array<ArrayBufferLike>, which TS won't
  // accept directly for importKey under newer lib typings).
  const raw = loadOrCreateMasterKeyBytes()
  const keyData = new Uint8Array(raw.length)
  keyData.set(raw)
  _masterKey = await globalThis.crypto.subtle.importKey(
    'raw', keyData, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
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
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(iv, 'base64') },
      key,
      Buffer.from(encryptedValue, 'base64'),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // AES-GCM auth-tag failure → the ciphertext can't be read with the current master
    // key (orphaned: encrypted under a previous key). Surface a clear, actionable error
    // instead of a raw 500 so the user knows exactly what to do.
    throw new CredentialError(
      "This saved credential couldn't be read — it was encrypted under a previous key. Open Connections, remove the affected connection or API key, and add it again.",
    )
  }
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
