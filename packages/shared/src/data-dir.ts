import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'

// The app's per-user data directory (encrypted DB, master/JWT keys, CLI token).
export const PMOS_DIR = join(homedir(), '.pmos')
const LEGACY_DIR = join(homedir(), '.creare')

// Ensure ~/.pmos exists, migrating a legacy ~/.creare install on first run.
// The product was renamed creare -> pm-os; existing local data lives under the old
// path. We rename the whole directory (keys.json, cli-token.json, and the SQLite DB
// all come along) plus the DB file itself, but ONLY when the new dir does not yet
// exist — so it runs exactly once and never clobbers a fresh ~/.pmos. Idempotent and
// safe to call from every entry point (DB open, CLI, etc.).
export function ensurePmosDataDir(): string {
  if (existsSync(PMOS_DIR)) return PMOS_DIR
  if (existsSync(LEGACY_DIR)) {
    renameSync(LEGACY_DIR, PMOS_DIR)
    for (const [from, to] of [
      ['creare.db', 'pmos.db'],
      ['creare.db-wal', 'pmos.db-wal'],
      ['creare.db-shm', 'pmos.db-shm'],
    ] as const) {
      const src = join(PMOS_DIR, from)
      if (existsSync(src)) renameSync(src, join(PMOS_DIR, to))
    }
  } else {
    mkdirSync(PMOS_DIR, { recursive: true })
  }
  return PMOS_DIR
}
