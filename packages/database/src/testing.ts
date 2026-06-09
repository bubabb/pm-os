import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { generateId } from '@creare/shared'
import * as schema from './schema'
import { users, projects, tasks, agentWorkspaces, integrationCredentials } from './schema'
import { setDb, getDb, resetDb } from './client'

// Test-only helpers. Builds a fresh in-memory SQLite database with all migrations
// applied and installs it as the active singleton, so domain code (which calls
// getDb()) transparently runs against an isolated, disposable database.
//
// Usage in a vitest suite:
//   import { createTestDb, destroyTestDb } from '@creare/database/testing'
//   beforeEach(() => { db = createTestDb() })
//   afterEach(() => destroyTestDb())

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, 'migrations')

let _testSqlite: Database.Database | null = null

export function createTestDb(): BetterSQLite3Database<typeof schema> {
  destroyTestDb()
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  // Apply the same SQL migrations production uses — keeps tests honest to the real schema.
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  _testSqlite = sqlite
  setDb(db)
  return db
}

export function destroyTestDb(): void {
  if (_testSqlite) {
    _testSqlite.close()
    _testSqlite = null
  }
  // Clear the singleton so a later getDb() never hands back a closed connection.
  resetDb()
}

// Insert a user and return its id. Most domain rows require an owner/actor FK.
export function seedUser(name = 'Test User'): string {
  const id = generateId()
  getDb().insert(users).values({ id, email: `${id}@test.local`, name, role: 'admin' }).run()
  return id
}

// Insert a project owned by `ownerId` and return its id.
export function seedProject(ownerId: string, name = 'Test Project'): string {
  const id = generateId()
  getDb().insert(projects).values({ id, name, ownerId }).run()
  return id
}

// Insert a task and return its id (board items, DAG edges, etc. reference tasks).
export function seedTask(projectId: string, title = 'Test Task', type: 'human' | 'agent' = 'human'): string {
  const id = generateId()
  getDb().insert(tasks).values({ id, projectId, title, type }).run()
  return id
}

// Insert an agent workspace and return its id (traces and cost records reference one).
export function seedAgentWorkspace(projectId: string, name = 'Test Agent'): string {
  const id = generateId()
  getDb()
    .insert(agentWorkspaces)
    .values({ id, projectId, name, modelProvider: 'anthropic', modelId: 'claude-sonnet-4-6' })
    .run()
  return id
}

// Insert an integration credential and return its id (sync state + event cache reference it).
export function seedCredential(projectId: string, source: 'jira' | 'github' | 'confluence' | 'notion' | 'onedrive' = 'github'): string {
  const id = generateId()
  getDb()
    .insert(integrationCredentials)
    .values({ id, projectId, source, label: 'test', encryptedToken: 'enc', iv: 'iv', metadata: '{}' })
    .run()
  return id
}

// Convenience: a fresh DB plus a user and project, the common starting point.
export function seedWorkspace(): { db: BetterSQLite3Database<typeof schema>; userId: string; projectId: string } {
  const db = createTestDb()
  const userId = seedUser()
  const projectId = seedProject(userId)
  return { db, userId, projectId }
}
