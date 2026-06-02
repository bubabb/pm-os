import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { join } from 'path'
import { homedir, mkdirSync } from 'os'
import * as schema from './schema'

// Database lives at ~/.creare/creare.db — never in the app bundle
const dbDir = join(homedir(), '.creare')
mkdirSync(dbDir, { recursive: true })
const dbPath = join(dbDir, 'creare.db')

// Singleton — one connection per process
let _db: ReturnType<typeof drizzle> | null = null

export function getDb() {
  if (!_db) {
    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')   // better concurrent read performance
    sqlite.pragma('foreign_keys = ON')    // enforce FK constraints
    _db = drizzle(sqlite, { schema })
  }
  return _db
}

export type Db = ReturnType<typeof getDb>
