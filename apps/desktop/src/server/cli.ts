/**
 * Creare CLI — a thin, scriptable client over the same localhost API the web UI
 * and Electron app use. No Electron, no browser: authenticates via the
 * /auth/sign-in dev-stub, caches the JWT, and prints tables (or --json).
 *
 * Run:  tsx src/server/cli.ts <command> [args]   (see package.json "cli" script)
 * Point at a non-default port with CREARE_PORT, or a full URL with CREARE_API.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const PORT = process.env['CREARE_PORT'] ?? '4321'
const BASE = process.env['CREARE_API'] ?? `http://127.0.0.1:${PORT}`
const TOKEN_FILE = join(homedir(), '.creare', 'cli-token.json')
const JSON_OUT = process.argv.includes('--json')

// ---- auth (dev-stub) -------------------------------------------------------

function readToken(): string | null {
  try {
    return (JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as { token?: string }).token ?? null
  } catch {
    return null
  }
}

function writeToken(token: string): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true })
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }), { mode: 0o600 })
}

async function signIn(): Promise<string> {
  const res = await fetch(`${BASE}/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'github' }), // dev-stub when no OAuth app is configured
  })
  if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${await res.text()}`)
  const { token } = (await res.json()) as { token: string }
  writeToken(token)
  return token
}

// ---- transport -------------------------------------------------------------

async function api<T>(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<T> {
  let token = readToken()
  if (!token) token = await signIn()

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string>),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      throw new Error(
        `Cannot reach Creare at ${BASE}. Is the server running?  Start it with:  pnpm creare`,
      )
    }
    throw err
  }

  // Stale/expired token — re-auth once and retry.
  if (res.status === 401 && allowRetry) {
    await signIn()
    return api<T>(path, init, false)
  }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

// ---- output ----------------------------------------------------------------

function printTable(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('(none)')
    return
  }
  const cell = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
  )
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  console.log(line(columns))
  console.log(line(widths.map((w) => '─'.repeat(w))))
  for (const r of rows) console.log(line(columns.map((c) => cell(r[c]))))
}

function printObject(obj: Record<string, unknown>): void {
  if (JSON_OUT) {
    console.log(JSON.stringify(obj, null, 2))
    return
  }
  for (const [k, v] of Object.entries(obj)) {
    console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
}

// ---- commands --------------------------------------------------------------

const USAGE = `Creare CLI — scriptable client for the local Creare server (${BASE})

Usage: creare <command> [args] [--json]

Commands:
  health                       Server health check (no auth)
  projects [--all]             List your projects (--all includes archived)
  boards <projectId>           List boards in a project
  connections                  List connected accounts (global)
  sources <projectId>          List a project's sources + sync status
  status <projectId>           Sync status for a project's sources
  sync <projectId> [source]    Trigger a sync (optionally one source, e.g. github)
  open                         Print the web UI URL
  help                         Show this help

Flags:
  --json                       Output raw JSON instead of a table
Env:
  CREARE_PORT (default 4321)   Server port        CREARE_API   Full base URL override`

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--json')
  const cmd = args[0] ?? 'help'

  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE)
      return

    case 'open':
      console.log(BASE)
      return

    case 'health': {
      // Health needs no auth — hit it directly so `creare health` works even
      // before sign-in and surfaces a clean "is it up?" answer.
      try {
        const res = await fetch(`${BASE}/health`)
        printObject((await res.json()) as Record<string, unknown>)
      } catch {
        throw new Error(`Cannot reach Creare at ${BASE}. Start it with:  pnpm creare`)
      }
      return
    }

    case 'projects': {
      const all = args.includes('--all')
      const rows = await api<Array<Record<string, unknown>>>(
        `/projects${all ? '?archived=1' : ''}`,
      )
      printTable(rows, ['id', 'name', 'description', 'createdAt'])
      return
    }

    case 'boards': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: creare boards <projectId>')
      const rows = await api<Array<Record<string, unknown>>>(`/projects/${projectId}/boards`)
      printTable(rows, ['id', 'name', 'type'])
      return
    }

    case 'connections': {
      const rows = await api<Array<Record<string, unknown>>>('/connections')
      printTable(rows, ['id', 'source', 'label', 'createdAt'])
      return
    }

    case 'sources': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: creare sources <projectId>')
      const rows = await api<Array<Record<string, unknown>>>(
        `/projects/${projectId}/integrations`,
      )
      printTable(rows, ['id', 'source', 'syncStatus', 'lastSyncedAt', 'syncError'])
      return
    }

    case 'status': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: creare status <projectId>')
      const out = await api<Record<string, unknown>>(`/projects/${projectId}/integrations/status`)
      if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
      else if (Array.isArray(out)) printTable(out as Array<Record<string, unknown>>, Object.keys((out[0] as object) ?? {}))
      else printObject(out)
      return
    }

    case 'sync': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: creare sync <projectId> [source]')
      const source = args[2]
      const out = await api<Record<string, unknown>>(
        `/projects/${projectId}/integrations/sync`,
        { method: 'POST', body: JSON.stringify(source ? { source } : {}) },
      )
      printObject(out)
      return
    }

    default:
      console.error(`Unknown command: ${cmd}\n`)
      console.log(USAGE)
      process.exitCode = 1
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
