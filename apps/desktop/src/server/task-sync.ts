/**
 * Task import/export bridge — the pure, dependency-free half.
 *
 * The canonical source of a scaffolded project's tasks is its markdown files in
 * `<projectDir>/agent-state/tasks/*.md` (YAML frontmatter + a free-form Notes body).
 * This module parses those files, maps their fields to/from the Pm.Os task shape,
 * and reads/writes the `.pmos-project.json` pointer that binds a project directory
 * to a Pm.Os project id. All API/network orchestration lives in the CLI (cli.ts);
 * everything here is synchronous filesystem + string work so it stays trivially
 * testable and side-effect-light.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

// ── Status enums + mapping ──────────────────────────────────────────────────

// Template (markdown) statuses — the vocabulary of agent-state/tasks/*.md.
export type TemplateStatus = 'todo' | 'claimed' | 'doing' | 'review' | 'done' | 'blocked'
// Pm.Os task statuses — the vocabulary of the tasks table.
export type PmosStatus =
  | 'pending' | 'in_progress' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'

const TEMPLATE_STATUSES: readonly TemplateStatus[] = [
  'todo', 'claimed', 'doing', 'review', 'done', 'blocked',
]

const TEMPLATE_TO_PMOS: Record<TemplateStatus, PmosStatus> = {
  todo: 'pending',
  claimed: 'pending',
  doing: 'in_progress',
  review: 'waiting_approval',
  done: 'completed',
  blocked: 'pending',
}

// Reverse, best-effort — the pmos vocabulary is wider than the template's, so
// several pmos statuses collapse onto a single template status.
const PMOS_TO_TEMPLATE: Record<PmosStatus, TemplateStatus> = {
  pending: 'todo',
  in_progress: 'doing',
  waiting_approval: 'review',
  completed: 'done',
  failed: 'blocked',
  cancelled: 'blocked',
}

export function templateStatusToPmos(status: TemplateStatus): PmosStatus {
  return TEMPLATE_TO_PMOS[status]
}

export function pmosStatusToTemplate(status: PmosStatus): TemplateStatus {
  return PMOS_TO_TEMPLATE[status]
}

function isTemplateStatus(value: string): value is TemplateStatus {
  return (TEMPLATE_STATUSES as readonly string[]).includes(value)
}

// ── Types ───────────────────────────────────────────────────────────────────

// A task as it exists in a markdown file — the canonical contract fields only.
export interface MarkdownTask {
  sourceId: string
  title: string
  status: TemplateStatus
  owner: string
  due: string // 'YYYY-MM-DD' or '-'
  acceptance: string
}

// The `.pmos-project.json` pointer bound to a project directory.
export interface PmosProjectRef {
  projectId: string
  projectName?: string
}

// ── Frontmatter parsing (zero-dep) ──────────────────────────────────────────

interface ParsedFile {
  // Ordered frontmatter entries — insertion order preserved so a rewrite keeps
  // the file's original field order and any fields we don't map (branch, handoff…).
  entries: Array<{ key: string; value: string }>
  // Everything after the closing `---`, verbatim — the human Notes section.
  body: string
  // True when the file opened a `---` fence but never closed it. Such a file has
  // no separable body, so it must NEVER be rewritten (that would eat the Notes).
  malformed: boolean
}

// Strips a YAML-style trailing comment and unquotes a raw value, unescaping the
// `\"`/`\\` sequences that `formatValue` writes so a quoted value round-trips.
// A `#` only begins a comment when it is at the start or preceded by whitespace
// (so a `#` inside a title like "fix #42 crash" survives). Quoted values are
// taken literally (escapes aside) and never comment-stripped.
function normalizeValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const first = trimmed[0]
  if (first === '"' || first === "'") {
    // Escape-aware scan to the matching closing quote: a backslash takes the next
    // char literally, so `"say \"hi\""` reads back as `say "hi"`.
    let out = ''
    for (let i = 1; i < trimmed.length; i++) {
      const c = trimmed[i]!
      if (c === '\\' && i + 1 < trimmed.length) { out += trimmed[i + 1]!; i++; continue }
      if (c === first) return out
      out += c
    }
    return out // unterminated quote — take what we have
  }
  // Cut at the first " #" (space-then-hash) or a leading "#".
  let cut = trimmed.length
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '#' && (i === 0 || trimmed[i - 1] === ' ' || trimmed[i - 1] === '\t')) {
      cut = i
      break
    }
  }
  return trimmed.slice(0, cut).trim()
}

// Splits a file into its frontmatter entries and body. Files with no leading
// `---` frontmatter block yield an empty entry list and the whole text as body.
// A file that opens `---` but never closes it is flagged `malformed` (body is
// left as the whole text so the caller can refuse to rewrite it).
export function parseFile(text: string): ParsedFile {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { entries: [], body: normalized, malformed: false }
  }
  const entries: Array<{ key: string; value: string }> = []
  let i = 1
  let closed = false
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') { i++; closed = true; break }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    if (key.length === 0) continue
    entries.push({ key, value: normalizeValue(line.slice(colon + 1)) })
  }
  if (!closed) {
    // Opening fence, no closing fence — refuse to interpret the body as frontmatter.
    return { entries: [], body: normalized, malformed: true }
  }
  const body = lines.slice(i).join('\n')
  return { entries, body, malformed: false }
}

function entryValue(entries: ParsedFile['entries'], key: string): string {
  return entries.find((e) => e.key === key)?.value ?? ''
}

// Parses a single task file into a MarkdownTask, or null if it lacks the minimum
// contract fields (an `id`) or its frontmatter fence is malformed — such files
// are skipped rather than half-imported.
export function parseTaskFile(text: string): MarkdownTask | null {
  const { entries, malformed } = parseFile(text)
  if (malformed) return null
  const sourceId = entryValue(entries, 'id').trim()
  if (sourceId.length === 0) return null

  const rawStatus = entryValue(entries, 'status').trim()
  const status: TemplateStatus = isTemplateStatus(rawStatus) ? rawStatus : 'todo'
  const dueRaw = entryValue(entries, 'due').trim()

  return {
    sourceId,
    title: entryValue(entries, 'title').trim() || sourceId,
    status,
    owner: entryValue(entries, 'owner').trim() || 'unassigned',
    due: dueRaw.length === 0 ? '-' : dueRaw,
    acceptance: entryValue(entries, 'acceptance').trim(),
  }
}

// The files that are structural, not tasks — never imported/exported.
const SKIP_FILES = new Set(['_TEMPLATE.md', 'README.md'])

export function tasksDir(projectDir: string): string {
  return join(projectDir, 'agent-state', 'tasks')
}

const PMOS_TERMINAL: ReadonlySet<PmosStatus> = new Set(['completed', 'failed', 'cancelled'])

// Terminal pmos statuses are protected from being "un-terminated" by an import.
export function isTerminalPmosStatus(status: PmosStatus): boolean {
  return PMOS_TERMINAL.has(status)
}

// A `due` value is valid iff it is the `-` sentinel (meaning "no date") or a
// strict YYYY-MM-DD calendar date.
export function isValidDue(due: string): boolean {
  if (due === '-') return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false
  const [y, m, d] = due.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

export interface ReadTasksResult {
  tasks: MarkdownTask[]
  // Files that couldn't be turned into a task, with a human reason — reported,
  // never fatal, so one bad file doesn't abort the whole import.
  skipped: Array<{ file: string; reason: string }>
}

// Reads every task markdown file in `<projectDir>/agent-state/tasks/`, skipping
// the template/readme scaffolding. A file that can't be read or parsed is
// collected in `skipped` rather than thrown.
export function readMarkdownTasks(projectDir: string): ReadTasksResult {
  const dir = tasksDir(projectDir)
  const result: ReadTasksResult = { tasks: [], skipped: [] }
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || SKIP_FILES.has(name)) continue
    const path = join(dir, name)
    // Never follow a symlink — its target could sit outside the project.
    if (lstatSync(path).isSymbolicLink()) {
      result.skipped.push({ file: name, reason: 'symlink — refusing to follow' })
      continue
    }
    try {
      const task = parseTaskFile(readFileSync(path, 'utf-8'))
      if (task) result.tasks.push(task)
      else result.skipped.push({ file: name, reason: 'no `id` or malformed frontmatter fence' })
    } catch (err) {
      result.skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

// ── Description encoding (owner + source marker carried in the pmos task) ────
//
// pm-os has no free-text `owner`/`source` fields, so the markdown `owner` and
// originating `id` are carried at the TOP of the task `description`:
//
//   [pmos-source:<id>]
//   Owner: <owner>
//
//   <acceptance text>
//
// The `[pmos-source:<id>]` marker is the dedup key on re-import. It is a
// distinctive bracketed token anchored to its own line so a user's free-text
// acceptance can't accidentally impersonate it; putting it FIRST also keeps the
// acceptance (free text, below) cleanly separable on export.

// Single-line matchers for the header block. NOT `/m` — we test line-by-line and
// only consume the LEADING contiguous run, so a `Owner:` line buried in the
// user's real free text is never mistaken for a header field.
const SOURCE_LINE_RE = /^\[pmos-source:([^\]\n]+)\]\s*$/
const OWNER_LINE_RE = /^Owner:\s*(.*)$/

export function buildDescription(task: MarkdownTask): string {
  // Fixed header block: marker, then Owner, then a blank line, then the free text.
  const parts = [`[pmos-source:${task.sourceId}]`, `Owner: ${task.owner}`]
  const acceptance = task.acceptance.trim()
  if (acceptance.length > 0) parts.push('', acceptance)
  return parts.join('\n')
}

// The decoded view of a pmos task description our import wrote. The source id +
// owner live in a fixed HEADER BLOCK (the first contiguous marker/Owner lines);
// everything after it is the user's real free text and is preserved verbatim.
export interface DecodedDescription {
  sourceId: string | null
  owner: string
  body: string
}

export function decodeDescription(description: string | null): DecodedDescription {
  if (!description) return { sourceId: null, owner: 'unassigned', body: '' }
  const lines = description.split('\n')
  // The marker is ONLY honored as the very FIRST line — a marker-shaped line
  // anywhere else in a native task's free text must never hijack it.
  const first = SOURCE_LINE_RE.exec(lines[0] ?? '')
  if (!first) return { sourceId: null, owner: 'unassigned', body: description.replace(/^\n+/, '') }

  const sourceId = first[1]!.trim() || null
  let owner = 'unassigned'
  let i = 1
  // After the marker, consume the contiguous header run (the Owner line).
  for (; i < lines.length; i++) {
    const om = OWNER_LINE_RE.exec(lines[i]!)
    if (om) { owner = om[1]!.trim() || 'unassigned'; continue }
    break
  }
  // Drop the single blank separator the header ends with; keep the rest exactly —
  // a mid-body "Owner: …" note is real content, not a header field.
  const body = lines.slice(i).join('\n').replace(/^\n+/, '')
  return { sourceId, owner, body }
}

export function extractSourceId(description: string | null): string | null {
  return decodeDescription(description).sourceId
}

// ── .pmos-project.json ──────────────────────────────────────────────────────

export function pmosProjectPath(projectDir: string): string {
  return join(projectDir, '.pmos-project.json')
}

export function readPmosProjectRef(projectDir: string): PmosProjectRef | null {
  const path = pmosProjectPath(projectDir)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PmosProjectRef>
    if (typeof parsed.projectId !== 'string' || parsed.projectId.length === 0) return null
    const ref: PmosProjectRef = { projectId: parsed.projectId }
    if (typeof parsed.projectName === 'string') ref.projectName = parsed.projectName
    return ref
  } catch {
    return null
  }
}

export function writePmosProjectRef(projectDir: string, ref: PmosProjectRef): void {
  writeFileSync(pmosProjectPath(projectDir), `${JSON.stringify(ref, null, 2)}\n`)
}

// ── Export rendering (markdown write-back) ──────────────────────────────────

// A pmos task reduced to the markdown contract fields, ready to render.
export interface ExportTask {
  sourceId: string
  title: string
  status: TemplateStatus
  owner: string
  due: string
  acceptance: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'
}

// Reduces an id to a safe single path segment — strips path separators, `..`,
// and anything outside [A-Za-z0-9_-] so a hostile `Source task: ../../etc` can
// never steer the output filename outside the tasks directory.
function sanitizeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task'
}

export function taskFileName(sourceId: string, title: string): string {
  return `${sanitizeSegment(sourceId)}-${slugify(title)}.md`
}

// On export, keep the file's EXISTING status when it still round-trips to the
// same pmos status (so `claimed`/`blocked` aren't flattened to `todo` by the
// lossy reverse map). Only rewrite status on a genuine transition — or, for a
// new file with no prior status, use the reverse map.
export function reconcileTemplateStatus(existing: string | null, pmosStatus: PmosStatus): TemplateStatus {
  if (existing) {
    const { entries, malformed } = parseFile(existing)
    if (!malformed) {
      const raw = entryValue(entries, 'status').trim()
      if (isTemplateStatus(raw) && templateStatusToPmos(raw) === pmosStatus) return raw
    }
  }
  return pmosStatusToTemplate(pmosStatus)
}

// Normalizes a pmos dueDate (which may be a full ISO datetime) to the template's
// strict `YYYY-MM-DD`, or `-` when absent/unparseable. NEVER emits a value that
// would fail the template lint's `^\d{4}-\d{2}-\d{2}$|^-$`.
export function toTemplateDue(dueDate: string | null): string {
  if (!dueDate) return '-'
  const datePart = dueDate.slice(0, 10)
  return isValidDue(datePart) ? datePart : '-'
}

// Renders a value for a single frontmatter line. Newlines are collapsed to
// spaces (a frontmatter value must stay on one line — belt-and-braces; the
// export path already routes multi-line text into Notes), and the value is
// quoted + backslash/quote-escaped when it would otherwise be ambiguous YAML.
// `normalizeValue` reverses the escaping so the value round-trips.
function formatValue(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ').trim()
  if (oneLine.length === 0) return '""'
  if (oneLine === '-' || /[:#"'\\]/.test(oneLine)) {
    return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return oneLine
}

const DEFAULT_BODY = '\n## Notes\n'

// A managed, regenerated-each-export block that holds rich (multi-line) context
// carried in the pmos description. It lives BELOW the human Notes so a human's
// own notes are never clobbered, and is fully replaced on every export so a
// re-export can't duplicate it.
const NOTES_MARKER = '<!-- pmos:context (synced from Pm.Os — edit in Pm.Os) -->'

function mergeNotes(existingBody: string, extraNotes: string): string {
  const idx = existingBody.indexOf(NOTES_MARKER)
  const base = (idx >= 0 ? existingBody.slice(0, idx) : existingBody).replace(/\s+$/, '')
  const extra = extraNotes.trim()
  const head = base.length > 0 ? base : DEFAULT_BODY.replace(/\s+$/, '')
  if (extra.length === 0) return `${head}\n`
  return `${head}\n\n${NOTES_MARKER}\n${extra}\n`
}

// Regenerates a task file's frontmatter from an ExportTask while preserving the
// human Notes body and any frontmatter fields we don't map (branch, contracts,
// handoff, updated, …). `extraNotes` (multi-line context beyond the one-line
// acceptance) is routed into a managed Notes block, never the frontmatter. When
// no prior file exists, a minimal file is created.
export function renderTaskFile(existing: string | null, task: ExportTask, extraNotes = ''): string {
  const parsed = existing ? parseFile(existing) : { entries: [], body: DEFAULT_BODY, malformed: false }

  const mapped: Record<string, string> = {
    id: task.sourceId,
    title: task.title,
    status: task.status,
    owner: task.owner,
    due: task.due,
    acceptance: task.acceptance,
  }

  const entries = parsed.entries.length > 0
    ? parsed.entries.map((e) => (e.key in mapped ? { key: e.key, value: mapped[e.key]! } : e))
    : Object.entries(mapped).map(([key, value]) => ({ key, value }))

  // Ensure every mapped field is present even if the original file omitted it.
  for (const key of Object.keys(mapped)) {
    if (!entries.some((e) => e.key === key)) entries.push({ key, value: mapped[key]! })
  }

  const front = entries.map((e) => `${e.key}: ${formatValue(e.value)}`).join('\n')
  const body = mergeNotes(parsed.body.length > 0 ? parsed.body : DEFAULT_BODY, extraNotes)
  return `---\n${front}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`
}

export interface TaskFileIndex {
  index: Map<string, string>
  // Symlinked entries that were refused (never followed) — reported by the caller.
  symlinks: string[]
}

// Indexes existing task files by their frontmatter `id` → absolute path, so an
// export can update the right file in place instead of creating a duplicate.
// Symlinks are NEVER indexed or read — following one could read/lead a write to
// a target outside the project.
export function indexTaskFilesById(projectDir: string): TaskFileIndex {
  const dir = tasksDir(projectDir)
  const index = new Map<string, string>()
  const symlinks: string[] = []
  if (!existsSync(dir)) return { index, symlinks }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || SKIP_FILES.has(name)) continue
    const path = join(dir, name)
    if (lstatSync(path).isSymbolicLink()) { symlinks.push(name); continue }
    const parsed = parseFile(readFileSync(path, 'utf-8'))
    if (parsed.malformed) continue
    const id = entryValue(parsed.entries, 'id').trim()
    if (id.length > 0) index.set(id, path)
  }
  return { index, symlinks }
}

// Verifies a write target sits inside the tasks dir and is NOT a symlink — the
// last line of defense against a symlinked entry steering a write outside the
// project (string-prefix clamps miss symlinks; `realpathSync` dereferences them).
export function isSafeWriteTarget(tasksDirPath: string, targetPath: string): boolean {
  const realDir = realpathSync(tasksDirPath)
  const parent = dirname(targetPath)
  // The parent must resolve (through any symlinks) to exactly the tasks dir.
  if (!existsSync(parent) || realpathSync(parent) !== realDir) return false
  // An existing symlink AT the target would be written THROUGH — refuse.
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) return false
  return true
}

export function ensureTasksDir(projectDir: string): string {
  const dir = tasksDir(projectDir)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function defaultProjectName(projectDir: string): string {
  return basename(projectDir.replace(/[/\\]+$/, '')) || 'project'
}
