import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'

// The app's per-user data directory (encrypted DB, master/JWT keys, CLI token).
export const PMOS_DIR = join(homedir(), '.pmos')
const PMOS_DB = join(PMOS_DIR, 'pmos.db')
const LEGACY_DIR = join(homedir(), '.creare')

// Rename the legacy DB files to their pmos.* names, in place, inside ~/.pmos. Sidecars
// (-wal/-shm) BEFORE the main .db, so the completion sentinel (pmos.db) only appears
// once its WAL/SHM are already renamed alongside it. Every step is existence-guarded,
// so this is safe to run repeatedly (resumes a partial migration, never double-renames).
function renameLegacyDbFiles(): void {
  for (const [from, to] of [
    ['creare.db-wal', 'pmos.db-wal'],
    ['creare.db-shm', 'pmos.db-shm'],
    ['creare.db', 'pmos.db'],
  ] as const) {
    const src = join(PMOS_DIR, from)
    if (existsSync(src) && !existsSync(join(PMOS_DIR, to))) renameSync(src, join(PMOS_DIR, to))
  }
}

// Ensure ~/.pmos exists, migrating a legacy ~/.creare install on first run.
// The product was renamed creare -> pm-os; existing local data lives under the old path.
// Migration is crash-safe and idempotent:
//   - The completion sentinel is the RENAMED DB file (pmos.db), not merely the directory
//     — so an interrupted migration RESUMES on the next boot instead of leaving a
//     half-migrated ~/.pmos that orphans the data (better-sqlite3 would otherwise open a
//     fresh empty pmos.db and the real data would sit forgotten at ~/.pmos/creare.db).
//   - The directory is moved in ONE renameSync (carrying the DB together with its
//     -wal/-shm sidecars, so no committed WAL data is stranded); the file renames then
//     complete IN PLACE, and run whether or not the dir has already been moved.
export function ensurePmosDataDir(): string {
  if (existsSync(PMOS_DB)) return PMOS_DIR // already migrated, or a fresh install with a DB

  try {
    // Move the legacy dir if it hasn't been moved yet (atomic; guarded so a resumed
    // partial migration where ~/.pmos already exists doesn't attempt to re-move).
    if (existsSync(LEGACY_DIR) && !existsSync(PMOS_DIR)) renameSync(LEGACY_DIR, PMOS_DIR)
    // Complete the file renames in place — also covers a partial migration where the
    // dir was moved but the DB files weren't renamed yet (LEGACY_DIR already gone).
    if (existsSync(PMOS_DIR)) renameLegacyDbFiles()
  } catch (err) {
    // Concurrent first-run: another process won the directory rename. If the dir now
    // exists, finish the (idempotent) file renames and carry on rather than crashing.
    if (existsSync(PMOS_DIR)) {
      try {
        renameLegacyDbFiles()
      } catch {
        /* the process that won the race will complete it */
      }
      return PMOS_DIR
    }
    throw err
  }

  // Fresh install (nothing to migrate), or a legacy dir that had keys but no DB yet —
  // getDb() will create pmos.db and the next boot's sentinel short-circuits.
  if (!existsSync(PMOS_DIR)) mkdirSync(PMOS_DIR, { recursive: true })
  return PMOS_DIR
}
