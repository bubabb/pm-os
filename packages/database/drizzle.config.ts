import type { Config } from 'drizzle-kit'
import { join } from 'path'
import { homedir } from 'os'

const dbPath = join(homedir(), '.pmos', 'pmos.db')

export default {
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath },
} satisfies Config
