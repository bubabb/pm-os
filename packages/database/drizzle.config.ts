import type { Config } from 'drizzle-kit'
import { join } from 'path'
import { ensurePmosDataDir } from '@pm-os/shared'

// Migrate a legacy ~/.creare install (and ensure ~/.pmos exists) BEFORE drizzle-kit
// opens the DB — otherwise db:generate/migrate/push on a not-yet-migrated machine would
// operate on a fresh empty pmos.db alongside the orphaned legacy data.
const dbPath = join(ensurePmosDataDir(), 'pmos.db')

export default {
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath },
} satisfies Config
