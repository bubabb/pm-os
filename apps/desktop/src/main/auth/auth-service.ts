import { safeStorage } from 'electron'
import { SignJWT, jwtVerify } from 'jose'
import { getDb } from '@creare/database'
import { users } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { User } from '@creare/database'

const JWT_ISSUER = 'creare'
const JWT_AUDIENCE = 'creare-desktop'
const SESSION_KEY = 'creare_session_token'
const KEYS_FILE = join(homedir(), '.creare', 'keys.json')

// Lazily initialised — derived once per process from disk-persisted encrypted blob
let _jwtSecret: Uint8Array | null = null

interface KeysFile {
  jwtSecretBlob?: string  // safeStorage-encrypted base64 of the raw hex secret
  masterKeyBlob?: string  // safeStorage-encrypted base64 of the 32-byte master key
}

function readKeysFile(): KeysFile {
  try {
    if (existsSync(KEYS_FILE)) {
      return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as KeysFile
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return {}
}

function writeKeysFile(patch: Partial<KeysFile>): void {
  const existing = readKeysFile()
  writeFileSync(KEYS_FILE, JSON.stringify({ ...existing, ...patch }, null, 2), { mode: 0o600 })
}

export function getJwtSecret(): Uint8Array {
  if (_jwtSecret) return _jwtSecret

  const keys = readKeysFile()
  if (keys.jwtSecretBlob && safeStorage.isEncryptionAvailable()) {
    try {
      const raw = safeStorage.decryptString(Buffer.from(keys.jwtSecretBlob, 'base64'))
      if (raw.length === 64) {
        _jwtSecret = new TextEncoder().encode(raw)
        return _jwtSecret
      }
    } catch {
      // fall through to generate
    }
  }

  // First boot or corrupted key file: generate a random 256-bit secret
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const raw = Buffer.from(bytes).toString('hex') // 64 hex chars
  _jwtSecret = new TextEncoder().encode(raw)

  if (safeStorage.isEncryptionAvailable()) {
    writeKeysFile({ jwtSecretBlob: safeStorage.encryptString(raw).toString('base64') })
  }

  return _jwtSecret
}

export async function signIn(provider: 'github' | 'entra'): Promise<User> {
  // Phase 1: creates/upserts a dev user so the UI shell can function.
  // Real OAuth flow (browser window + code exchange) ships in Phase 3.
  const db = getDb()
  const devEmail = provider === 'github' ? 'dev@github.local' : 'dev@entra.local'
  const devName  = provider === 'github' ? 'Dev (GitHub)' : 'Dev (Entra)'

  const existing = await db.select().from(users).where(eq(users.email, devEmail)).limit(1)

  let user: User
  if (existing.length > 0) {
    user = existing[0]!
  } else {
    const [created] = await db
      .insert(users)
      .values({ id: generateId(), email: devEmail, name: devName, role: 'admin' })
      .returning()
    user = created!
  }

  const token = await createSessionToken(user.id)
  persistToken(token)
  return user
}

export async function signOut(): Promise<void> {
  clearToken()
}

export async function getCurrentUser(): Promise<User | null> {
  const token = loadToken()
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    })
    const userId = payload['sub']
    if (!userId) return null

    const db = getDb()
    const result = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    return result[0] ?? null
  } catch {
    return null
  }
}

export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    })
    return payload['sub'] ?? null
  } catch {
    return null
  }
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getJwtSecret())
}

function persistToken(token: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    process.env[SESSION_KEY] = safeStorage.encryptString(token).toString('base64')
  } else {
    process.env[SESSION_KEY] = token
  }
}

function loadToken(): string | null {
  const stored = process.env[SESSION_KEY]
  if (!stored) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    }
    return stored
  } catch {
    return null
  }
}

function clearToken(): void {
  delete process.env[SESSION_KEY]
}

export { readKeysFile, writeKeysFile }
