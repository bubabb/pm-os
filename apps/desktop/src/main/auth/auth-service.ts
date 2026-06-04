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
const KEYS_FILE = join(homedir(), '.creare', 'keys.json')

let _jwtSecret: Uint8Array | null = null

interface KeysFile {
  jwtSecretBlob?: string  // safeStorage-encrypted base64 of the raw hex secret
  masterKeyBlob?: string  // safeStorage-encrypted base64 of the 32-byte master key
}

export function readKeysFile(): KeysFile {
  try {
    if (existsSync(KEYS_FILE)) {
      return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as KeysFile
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return {}
}

export function writeKeysFile(patch: Partial<KeysFile>): void {
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

  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const raw = Buffer.from(bytes).toString('hex')
  _jwtSecret = new TextEncoder().encode(raw)

  if (safeStorage.isEncryptionAvailable()) {
    writeKeysFile({ jwtSecretBlob: safeStorage.encryptString(raw).toString('base64') })
  }

  return _jwtSecret
}

// Phase 1: creates/upserts a dev user. Real OAuth (browser window + code exchange) ships in Phase 3.
export async function signIn(provider: 'github' | 'entra'): Promise<User> {
  const db = getDb()
  const devEmail = provider === 'github' ? 'dev@github.local' : 'dev@entra.local'
  const devName  = provider === 'github' ? 'Dev (GitHub)' : 'Dev (Entra)'

  const existing = await db.select().from(users).where(eq(users.email, devEmail)).limit(1)

  if (existing.length > 0) return existing[0]!

  const [created] = await db
    .insert(users)
    .values({ id: generateId(), email: devEmail, name: devName, role: 'admin' })
    .returning()
  return created!
}

export async function signOut(): Promise<void> {
  // Session lives in the renderer's localStorage — clearToken() in api.ts handles it.
  // Nothing to do in the main process.
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
