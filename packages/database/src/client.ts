import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'
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

export type Db = BetterSQLite3Database<typeof schema>
