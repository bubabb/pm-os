import { safeStorage } from 'electron'
import { SignJWT, jwtVerify } from 'jose'
import { getDb } from '@creare/database'
import { users } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'
import type { User } from '@creare/database'

const JWT_ISSUER = 'creare'
const JWT_AUDIENCE = 'creare-desktop'
const SESSION_KEY = 'creare_session_token'
const SECRET_STORAGE_KEY = 'creare_jwt_secret'

// Lazily initialised — derived once per process, stored in safeStorage
let _jwtSecret: Uint8Array | null = null

function getJwtSecret(): Uint8Array {
  if (_jwtSecret) return _jwtSecret

  const existing = safeStorage.decryptString(
    Buffer.from(safeStorage.encryptString(''), 'base64')
  )
  // Try to load persisted secret; generate if missing
  try {
    const raw = safeStorage.decryptString(
      Buffer.from(process.env['CREARE_JWT_SECRET_BLOB'] ?? '', 'base64')
    )
    if (raw.length === 64) {
      _jwtSecret = new TextEncoder().encode(raw)
      return _jwtSecret
    }
  } catch {
    // generate fresh
  }

  // First boot: generate a random 256-bit secret and store it
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const raw = Buffer.from(bytes).toString('hex') // 64 hex chars
  _jwtSecret = new TextEncoder().encode(raw)
  // Persist encrypted in env for the process lifetime; a real impl would write to a file
  process.env['CREARE_JWT_SECRET_BLOB'] = safeStorage.encryptString(raw).toString('base64')
  return _jwtSecret
  void existing // suppress unused warning
}

export async function signIn(provider: 'github' | 'entra'): Promise<User> {
  // In Phase 1 this creates/upserts a dev user so the UI shell can function.
  // Real OAuth flow (opening a browser window, exchanging the code) is a Phase 3 concern
  // because it requires a registered OAuth app with a redirect URI.
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

async function createSessionToken(userId: string): Promise<string> {
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
    const encrypted = safeStorage.encryptString(token).toString('base64')
    process.env[SESSION_KEY] = encrypted
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
