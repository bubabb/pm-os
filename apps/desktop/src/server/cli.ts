/**
 * Pm.Os CLI — a thin, scriptable client over the same localhost API the web UI
 * and Electron app use. No Electron, no browser: authenticates via the
 * /auth/sign-in dev-stub, caches the JWT, and prints tables (or --json).
 *
 * Run:  tsx src/server/cli.ts <command> [args]   (see package.json "cli" script)
 * Point at a non-default port with PMOS_PORT, or a full URL with PMOS_API.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { ensurePmosDataDir } from '@pm-os/shared'
import { basename, dirname, join, resolve, sep } from 'path'
import {
  buildDescription,
  decodeDescription,
  defaultProjectName,
  ensureTasksDir,
  extractSourceId,
  indexTaskFilesById,
  isSafeWriteTarget,
  isTerminalPmosStatus,
  isValidDue,
  parseFile,
  readMarkdownTasks,
  readPmosProjectRef,
  reconcileTemplateStatus,
  renderTaskFile,
  taskFileName,
  tasksDir,
  templateStatusToPmos,
  toTemplateDue,
  writePmosProjectRef,
} from './task-sync'
import type { ExportTask, MarkdownTask, PmosStatus } from './task-sync'

// Validate PMOS_PORT: unset → 4321, but a set-but-invalid value must fail loudly
// rather than build a nonsense URL. Ignored when PMOS_API overrides the base URL.
function resolvePort(): string {
  const raw = process.env['PMOS_PORT']
  if (raw === undefined || raw === '') return '4321'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PMOS_PORT: "${raw}" — must be an integer between 1 and 65535`)
  }
  return String(port)
}

const PORT = process.env['PMOS_API'] ? '' : resolvePort()
const BASE = process.env['PMOS_API'] ?? `http://127.0.0.1:${PORT}`
const TOKEN_FILE = join(homedir(), '.pmos', 'cli-token.json')
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
  // The mode option only applies when the file is *created*; an existing token file
  // keeps its old perms. Create the dir 0700 and chmod the file 0600 after writing so
  // the cached JWT is always owner-only, even on rewrite.
  ensurePmosDataDir() // migrate a legacy ~/.creare install if present
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 })
  writeFileSync(TOKEN_FILE, JSON.stringify({ token }), { mode: 0o600 })
  chmodSync(TOKEN_FILE, 0o600)
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
        `Cannot reach Pm.Os at ${BASE}. Is the server running?  Start it with:  pnpm pm-os`,
      )
    }
    throw err
  }

  // Stale/expired token — re-auth once and retry.
  if (res.status === 401 && allowRetry) {
    await signIn()
    return api<T>(path, init, false)
  }
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try {
      const body = JSON.parse(text) as { message?: string; error?: string }
      detail = body.message ?? body.error ?? text
    } catch {
      // non-JSON body — show as-is
    }
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${detail}`)
  }
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

// ---- task import/export bridge ---------------------------------------------

// The subset of the pmos Task shape the bridge reads back from the API.
interface ApiTask {
  id: string
  title: string
  description: string | null
  status: PmosStatus
  dueDate: string | null
}
interface ApiProject { id: string; name: string }

// Resolves the pmos project for a directory: honour an existing .pmos-project.json,
// else find-or-create a project by name and persist the pointer. Never writes a
// partial pointer — the file is only written once a real project id is in hand.
async function resolveProjectId(projectDir: string, nameFlag: string | undefined): Promise<string> {
  const ref = readPmosProjectRef(projectDir)
  if (ref) {
    try {
      const project = await api<ApiProject>(`/projects/${ref.projectId}`)
      return project.id // still exists — use it as-is
    } catch (err) {
      // Only a genuine 404 means the recorded project is gone. A 500/transient
      // error (or an unreachable server) must surface — never silently rebind to
      // a fresh duplicate project on top of a hiccup.
      if (!(err instanceof Error && /→\s*404\b/.test(err.message))) throw err
      // 404 → fall through and re-resolve by name.
    }
  }

  const projectName = nameFlag ?? ref?.projectName ?? defaultProjectName(projectDir)
  const projects = await api<ApiProject[]>('/projects')
  let project = projects.find((p) => p.name === projectName)
  if (!project) {
    project = await api<ApiProject>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: projectName }),
    })
  }
  writePmosProjectRef(projectDir, { projectId: project.id, projectName: project.name })
  return project.id
}

// A task's status may only advance to a terminal state, never leave one. This
// stops an export→import cycle (failed/cancelled → blocked → pending) from
// resurrecting a finished task.
function statusChangeAllowed(existing: PmosStatus, incoming: PmosStatus): boolean {
  if (isTerminalPmosStatus(existing)) return incoming === 'completed'
  return true
}

// Resolves a markdown `due` into a concrete import action, warning on garbage.
type DueAction = { kind: 'set'; value: string } | { kind: 'clear' } | { kind: 'skip' }
function resolveDue(sourceId: string, due: string, warn: (msg: string) => void): DueAction {
  if (due === '-') return { kind: 'clear' }
  if (isValidDue(due)) return { kind: 'set', value: due }
  warn(`  ${sourceId}: ignoring invalid due "${due}" — must be YYYY-MM-DD or -`)
  return { kind: 'skip' }
}

async function tasksImport(projectDir: string, nameFlag: string | undefined): Promise<void> {
  const dir = resolve(projectDir)
  const { tasks: readTasks, skipped: readSkipped } = readMarkdownTasks(dir)
  for (const s of readSkipped) console.error(`  skipped ${s.file}: ${s.reason}`)

  // Dedupe markdown tasks by id BEFORE the upsert loop (last-file-wins) so two
  // files sharing an id resolve to one deterministic task instead of flip-flopping
  // the DB row on every run.
  const byId = new Map<string, MarkdownTask>()
  for (const md of readTasks) {
    if (byId.has(md.sourceId)) {
      console.error(`  duplicate id ${md.sourceId} — later file wins, earlier dropped`)
    }
    byId.set(md.sourceId, md)
  }
  const mdTasks = [...byId.values()]

  if (mdTasks.length === 0) {
    console.log(`No task files found in ${tasksDir(dir)} (nothing to import).`)
    return
  }

  const projectId = await resolveProjectId(dir, nameFlag)

  // Build the dedup index: existing pmos tasks keyed by their embedded source marker.
  const existing = await api<ApiTask[]>(`/projects/${projectId}/tasks`)
  const bySource = new Map<string, ApiTask>()
  for (const t of existing) {
    const sid = extractSourceId(t.description)
    if (sid) bySource.set(sid, t)
  }

  let created = 0
  let updated = 0
  let unchanged = 0
  for (const md of mdTasks) {
    const description = buildDescription(md)
    const incomingStatus = templateStatusToPmos(md.status)
    const due = resolveDue(md.sourceId, md.due, (m) => console.error(m))
    const match = bySource.get(md.sourceId)

    if (match) {
      // Metadata-idempotent: only PATCH the fields that actually changed, so a
      // re-run neither emits an event nor resets startedAt/completedAt.
      const patch: {
        status?: PmosStatus; title?: string; description?: string; dueDate?: string | null
      } = {}
      if (match.status !== incomingStatus) {
        if (statusChangeAllowed(match.status, incomingStatus)) {
          patch.status = incomingStatus
        } else {
          // Terminal task: content still syncs (markdown is canonical) but the
          // status change is intentionally dropped — surface it, don't hide it.
          console.error(`  ${md.sourceId}: keeping terminal status '${match.status}' — not applying '${incomingStatus}'`)
        }
      }
      if (match.title !== md.title) patch.title = md.title
      if (match.description !== description) patch.description = description
      if (due.kind === 'set' && match.dueDate !== due.value) patch.dueDate = due.value
      else if (due.kind === 'clear' && match.dueDate !== null) patch.dueDate = null

      if (Object.keys(patch).length === 0) {
        unchanged++
      } else {
        await api(`/projects/${projectId}/tasks/${match.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        })
        updated++
      }
    } else {
      const body: { title: string; description: string; type: 'human'; dueDate?: string } = {
        title: md.title,
        description,
        type: 'human',
      }
      if (due.kind === 'set') body.dueDate = due.value
      const task = await api<ApiTask>(`/projects/${projectId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      // createTask always starts 'pending'; nudge to the mapped status if it differs.
      if (incomingStatus !== 'pending') {
        await api(`/projects/${projectId}/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: incomingStatus }),
        })
      }
      // Register the new task so a second markdown file with the SAME id in this
      // run updates it instead of creating a duplicate.
      bySource.set(md.sourceId, {
        id: task.id,
        title: md.title,
        description,
        status: incomingStatus,
        dueDate: due.kind === 'set' ? due.value : null,
      })
      created++
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ projectId, created, updated, unchanged, total: mdTasks.length }, null, 2))
  } else {
    console.log(`Imported into project ${projectId}: ${created} created, ${updated} updated, ${unchanged} unchanged (${mdTasks.length} task file(s)).`)
  }
}

async function tasksExport(projectDir: string): Promise<void> {
  const dir = resolve(projectDir)
  const ref = readPmosProjectRef(dir)
  if (!ref) {
    throw new Error(
      `No .pmos-project.json in ${dir}. Run \`pm-os tasks import ${projectDir}\` first to bind this directory to a project.`,
    )
  }

  const tasks = await api<ApiTask[]>(`/projects/${ref.projectId}/tasks`)
  const { index: fileIndex, symlinks } = indexTaskFilesById(dir)
  const tdir = resolve(ensureTasksDir(dir))

  let written = 0
  let nativeSkipped = 0
  const fileSkipped: string[] = []
  for (const s of symlinks) fileSkipped.push(`${s}: symlink — refusing to index/write`)

  for (const t of tasks) {
    const decoded = decodeDescription(t.description)
    const sid = decoded.sourceId
    if (!sid) {
      // A pmos-native task (no markdown origin) — not written back.
      nativeSkipped++
      continue
    }
    // The pmos description's free text: first line is the one-line acceptance
    // observable; anything after it is rich context routed into the Notes body.
    const bodyLines = decoded.body.length > 0 ? decoded.body.split('\n') : ['']
    const acceptance = (bodyLines[0] ?? '').trim()
    const extraNotes = bodyLines.slice(1).join('\n').trim()

    // Prefer the file already carrying this id; else a fresh, sanitized filename.
    const targetPath = resolve(fileIndex.get(sid) ?? join(tdir, taskFileName(sid, t.title)))
    // String clamp first (cheap), then the real symlink-aware guard.
    if ((targetPath !== tdir && !targetPath.startsWith(tdir + sep))
        || !isSafeWriteTarget(tdir, targetPath)) {
      fileSkipped.push(`${sid}: unsafe write target (escapes tasks dir or symlink) — refused`)
      continue
    }
    // Never clobber a file we can't cleanly parse (a missing closing fence would
    // otherwise eat its Notes body).
    let existing: string | null = null
    if (existsSync(targetPath)) {
      existing = readFileSync(targetPath, 'utf-8')
      if (parseFile(existing).malformed) {
        fileSkipped.push(`${basename(targetPath)}: malformed frontmatter fence — not rewriting`)
        continue
      }
    }
    const exportTask: ExportTask = {
      sourceId: sid,
      title: t.title,
      // Preserve claimed/blocked etc when still consistent (avoid lossy downgrade).
      status: reconcileTemplateStatus(existing, t.status),
      owner: decoded.owner,
      due: toTemplateDue(t.dueDate),
      acceptance,
    }
    writeFileSync(targetPath, renderTaskFile(existing, exportTask, extraNotes))
    written++
  }

  for (const s of fileSkipped) console.error(`  skipped ${s}`)
  if (JSON_OUT) {
    console.log(JSON.stringify({ projectId: ref.projectId, written, nativeSkipped, fileSkipped }, null, 2))
  } else {
    const extra = [
      nativeSkipped > 0 ? `${nativeSkipped} pmos-native skipped` : '',
      fileSkipped.length > 0 ? `${fileSkipped.length} file(s) not rewritten` : '',
    ].filter(Boolean).join(', ')
    console.log(`Exported ${written} task file(s) to ${tdir}${extra ? ` (${extra})` : ''}.`)
  }
}

async function runTasks(rest: string[]): Promise<void> {
  const sub = rest[0]
  // Parse a --name <value> flag out of the remaining args.
  let nameFlag: string | undefined
  const positional: string[] = []
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === '--name') {
      nameFlag = rest[++i]
    } else {
      positional.push(rest[i]!)
    }
  }
  const projectDir = positional[0]

  if (sub === 'import') {
    if (!projectDir) throw new Error('usage: pm-os tasks import <projectDir> [--name <projectName>]')
    await tasksImport(projectDir, nameFlag)
    return
  }
  if (sub === 'export') {
    if (!projectDir) throw new Error('usage: pm-os tasks export <projectDir>')
    await tasksExport(projectDir)
    return
  }
  throw new Error('usage: pm-os tasks <import|export> <projectDir> [--name <projectName>]')
}

// ---- commands --------------------------------------------------------------

const USAGE = `Pm.Os CLI — scriptable client for the local Pm.Os server (${BASE})

Usage: pm-os <command> [args] [--json]

Commands:
  health                       Server health check (no auth)
  projects [--all]             List your projects (--all includes archived)
  boards <projectId>           List boards in a project
  connections                  List connected accounts (global)
  sources <projectId>          List a project's sources + sync status
  status <projectId>           Sync status for a project's sources
  sync <projectId> [source]    Trigger a sync (optionally one source, e.g. github)
  tasks import <dir> [--name <n>]  Import agent-state/tasks/*.md into a pm-os project
  tasks export <dir>           Write a pm-os project's tasks back to agent-state/tasks/*.md
  open                         Print the web UI URL
  help                         Show this help

Flags:
  --json                       Output raw JSON instead of a table
Env:
  PMOS_PORT (default 4321)   Server port        PMOS_API   Full base URL override`

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
      // Health needs no auth — hit it directly so `pm-os health` works even
      // before sign-in and surfaces a clean "is it up?" answer.
      try {
        const res = await fetch(`${BASE}/health`)
        printObject((await res.json()) as Record<string, unknown>)
      } catch {
        throw new Error(`Cannot reach Pm.Os at ${BASE}. Start it with:  pnpm pm-os`)
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
      if (!projectId) throw new Error('usage: pm-os boards <projectId>')
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
      if (!projectId) throw new Error('usage: pm-os sources <projectId>')
      const rows = await api<Array<Record<string, unknown>>>(
        `/projects/${projectId}/integrations`,
      )
      printTable(rows, ['id', 'source', 'syncStatus', 'lastSyncedAt', 'syncError'])
      return
    }

    case 'status': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: pm-os status <projectId>')
      const out = await api<Record<string, unknown>>(`/projects/${projectId}/integrations/status`)
      if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
      else if (Array.isArray(out)) printTable(out as Array<Record<string, unknown>>, Object.keys((out[0] as object) ?? {}))
      else printObject(out)
      return
    }

    case 'sync': {
      const projectId = args[1]
      if (!projectId) throw new Error('usage: pm-os sync <projectId> [source]')
      const source = args[2]
      const out = await api<Record<string, unknown>>(
        `/projects/${projectId}/integrations/sync`,
        { method: 'POST', body: JSON.stringify(source ? { source } : {}) },
      )
      printObject(out)
      return
    }

    case 'tasks': {
      await runTasks(args.slice(1))
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
