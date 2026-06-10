import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import * as schema from './schema'

const dbPath = join(homedir(), '.creare', 'creare.db')

// Singleton — one connection per process
let _db: BetterSQLite3Database<typeof schema> | null = null

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    // Create ~/.creare/ lazily — only when the DB is first opened, not at import time
    mkdirSync(join(homedir(), '.creare'), { recursive: true })
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')  // better concurrent read performance
    sqlite.pragma('foreign_keys = ON')   // enforce FK constraints
    _db = drizzle(sqlite, { schema })
  }
  return _db
}

// Override the singleton — used by the test harness to inject an in-memory database.
// Production code never calls this.
export function setDb(db: BetterSQLite3Database<typeof schema>): void {
  _db = db
}

// Drop the cached connection so the next getDb() rebuilds it (test teardown).
export function resetDb(): void {
  _db = null
}

// Apply any pending migrations to the on-disk DB. Call once at app startup so a
// fresh install gets a fully-migrated database with no manual `db:migrate` step.
// Idempotent — a no-op when the DB is already up to date.
// Migrations ship next to the built package (dist/migrations, copied by `build`);
// falls back to the source folder when running uncompiled.
export function runMigrations(): void {
  const candidates = [join(__dirname, 'migrations'), join(__dirname, '..', 'src', 'migrations')]
  const migrationsFolder = candidates.find((p) => existsSync(p))
  if (!migrationsFolder) {
    throw new Error(`migrations folder not found (looked in: ${candidates.join(', ')})`)
  }
  migrate(getDb(), { migrationsFolder })
}

export type Db = BetterSQLite3Database<typeof schema>
