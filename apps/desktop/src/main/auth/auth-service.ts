import { SignJWT, jwtVerify } from 'jose'
import { getDb } from '@pm-os/database'
import { users } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { eq } from 'drizzle-orm'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { User } from '@pm-os/database'

const JWT_ISSUER = 'pm-os'
const JWT_AUDIENCE = 'pm-os-desktop'
const KEYS_FILE = join(homedir(), '.pmos', 'keys.json')

let _jwtSecret: Uint8Array | null = null

interface KeysFile {
  // Stable, keyring-independent source of truth (base64). Once written these never
  // change, so a transient OS-keyring failure can no longer rotate the key and orphan
  // every previously-encrypted secret. The file is mode 0600 in the user's home dir —
  // a deliberate stability-over-at-rest-secrecy trade-off for a local-first, single-user
  // app (the prior keyring-wrapped scheme silently destroyed data on any keyring hiccup).
  jwtSecretRaw?: string   // base64 of the raw 64-char hex JWT secret
  masterKeyRaw?: string   // base64 of the raw 32-byte master key
  // Legacy safeStorage-wrapped forms — still read ONCE to migrate into the *Raw fields,
  // then ignored. Never written again.
  jwtSecretBlob?: string
  masterKeyBlob?: string
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
  // Atomic write: temp file + rename. A crash mid-write can never leave a truncated
  // keys.json — readKeysFile would treat that as corrupt, return {}, and the next boot
  // would silently mint a fresh master key, orphaning every encrypted secret (the exact
  // failure the stable-key scheme exists to prevent).
  const tmpFile = `${KEYS_FILE}.tmp`
  writeFileSync(tmpFile, JSON.stringify({ ...existing, ...patch }, null, 2), { mode: 0o600 })
  renameSync(tmpFile, KEYS_FILE)
}

export function getJwtSecret(): Uint8Array {
  if (_jwtSecret) return _jwtSecret

  const keys = readKeysFile()

  // 1. Stable raw secret — the source of truth once written. Used forever after.
  if (keys.jwtSecretRaw) {
    const raw = Buffer.from(keys.jwtSecretRaw, 'base64').toString('utf8')
    if (raw.length === 64) {
      _jwtSecret = new TextEncoder().encode(raw)
      return _jwtSecret
    }
  }

  // Legacy data-loss guard: an old keyring-wrapped secret exists but there is no raw
  // secret. Pm.Os is headless-only (no Electron/OS-keyring), so the blob can no longer be
  // unwrapped, and generating a new secret would silently invalidate every outstanding
  // session. Refuse unless the operator opts into discarding it with PMOS_ALLOW_KEY_REGEN=1.
  if (keys.jwtSecretBlob && process.env['PMOS_ALLOW_KEY_REGEN'] !== '1') {
    throw new Error(
      '[pm-os] Legacy keyring-wrapped JWT secret found but no raw secret, and headless Pm.Os ' +
        'cannot unwrap it. Set PMOS_ALLOW_KEY_REGEN=1 to discard the old secret and all sessions.',
    )
  }

  // 3. No recoverable secret — generate ONCE and persist raw (stable forever after).
  //    If a secret existed before (raw or legacy blob) but couldn't be recovered, this
  //    is a rotation: every outstanding session token becomes invalid. Say so loudly
  //    rather than silently signing users out.
  if (keys.jwtSecretRaw || keys.jwtSecretBlob) {
    console.error(
      '[pm-os] WARNING: generating a new JWT secret because the existing one could not be recovered — all existing sessions are invalidated and users must sign in again',
    )
  }
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const raw = Buffer.from(bytes).toString('hex')
  writeKeysFile({ jwtSecretRaw: Buffer.from(raw, 'utf8').toString('base64') })
  _jwtSecret = new TextEncoder().encode(raw)

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

// Upserts a real user authenticated via OAuth, keyed by email. Updates the
// display name / avatar on each sign-in so they stay current with the provider.
export async function upsertOAuthUser(profile: {
  email: string
  name: string
  avatarUrl: string | null
}): Promise<User> {
  const db = getDb()
  const existing = await db.select().from(users).where(eq(users.email, profile.email)).limit(1)

  if (existing.length > 0) {
    const [updated] = await db
      .update(users)
      .set({ name: profile.name, avatarUrl: profile.avatarUrl, updatedAt: new Date().toISOString() })
      .where(eq(users.id, existing[0]!.id))
      .returning()
    return updated!
  }

  // Local-first v1: the first person to sign in owns the install, so new users are
  // admins. Revisit when multi-user / team mode lands (would default to 'engineer').
  const [created] = await db
    .insert(users)
    .values({ id: generateId(), email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl, role: 'admin' })
    .returning()
  return created!
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
