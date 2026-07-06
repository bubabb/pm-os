import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompletionRequest, CompletionResponse } from '../types'

// The `claude-cli` provider shells out to the locally-installed Claude Code CLI
// in headless print mode (`claude -p --output-format json`). Unlike the other
// providers it does NOT use an API key — the CLI authenticates with the user's
// Claude subscription ("membership") login, so calls are covered by the plan
// instead of being billed against a pay-per-token API key.
//
// The CLI still reports `total_cost_usd` (the API-equivalent compute cost), which
// we surface as `costCents` so the observability domain keeps a meaningful number
// even though the membership — not an API key — is what actually pays for it.
//
// Caveats: print mode exposes no `temperature`/`max_tokens` flags, so those
// request fields are ignored here.

// The shape of the JSON object emitted by `claude -p --output-format json`.
interface ClaudeCliResult {
  type: string
  subtype: string
  is_error: boolean
  result?: string
  total_cost_usd?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// Render the message list into a single prompt string for print mode, which takes
// one turn. A lone user message (the common case) passes through verbatim; longer
// conversations become a labelled transcript so prior turns are preserved.
function renderPrompt(messages: CompletionRequest['messages']): string {
  if (messages.length === 1 && messages[0]!.role === 'user') {
    return messages[0]!.content
  }
  return messages
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

// Print mode auto-discovers project context — any CLAUDE.md in the cwd and its
// parents, plus local .claude settings. For a reasoning call that should be driven
// only by our prompt + system prompt, that context leaks in (non-deterministic by
// launch directory, wrong behavior, extra tokens). So we run the CLI in a dedicated
// EMPTY temp directory whose parents have no CLAUDE.md. (We can't use the CLI's
// "simple" mode to skip discovery — it also forces ANTHROPIC_API_KEY auth and
// ignores the membership login, defeating the whole provider.)
const isolatedCwd = join(tmpdir(), 'pm-os-ai-sdk-claude-cli')
let isolatedCwdReady: Promise<string> | null = null
function ensureIsolatedCwd(): Promise<string> {
  if (!isolatedCwdReady) {
    isolatedCwdReady = mkdir(isolatedCwd, { recursive: true }).then(() => isolatedCwd)
  }
  return isolatedCwdReady
}

function runClaude(args: string[], stdin: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (err: Error) => { if (!settled) { settled = true; reject(err) } }
    const done = (out: string) => { if (!settled) { settled = true; resolve(out) } }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      fail(new Error(
        `Failed to spawn the 'claude' CLI — is Claude Code installed and on PATH? (${err.message})`,
      ))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
        return
      }
      done(stdout)
    })

    // The stdin pipe can emit EPIPE if the child exits before/while we write to it.
    // Without this listener that 'error' is unhandled and crashes the whole host
    // process (Electron main). Swallow it here — the child 'error'/'close' handlers
    // above carry the real outcome. Guard the write/end the same way.
    child.stdin.on('error', () => { /* handled via child 'error'/'close' */ })
    try {
      child.stdin.write(stdin)
      child.stdin.end()
    } catch {
      // The pipe was already torn down; the outcome surfaces via 'error'/'close'.
    }
  })
}

export async function completeClaudeCli(
  request: CompletionRequest,
): Promise<CompletionResponse> {
  const args = ['-p', '--output-format', 'json', '--model', request.model]
  if (request.systemPrompt !== undefined) {
    args.push('--append-system-prompt', request.systemPrompt)
  }

  const startMs = Date.now()
  const stdout = await runClaude(args, renderPrompt(request.messages), await ensureIsolatedCwd())
  const durationMs = Date.now() - startMs

  let parsed: ClaudeCliResult
  try {
    parsed = JSON.parse(stdout) as ClaudeCliResult
  } catch {
    throw new Error(`Could not parse claude CLI JSON output: ${stdout.slice(0, 500)}`)
  }

  if (parsed.is_error) {
    throw new Error(`claude CLI returned an error result: ${parsed.result ?? parsed.subtype}`)
  }

  const inputTokens = parsed.usage?.input_tokens ?? 0
  const outputTokens = parsed.usage?.output_tokens ?? 0

  return {
    content: parsed.result ?? '',
    inputTokens,
    outputTokens,
    // total_cost_usd → cents; covered by the membership, reported for observability.
    costCents: Math.ceil((parsed.total_cost_usd ?? 0) * 100),
    durationMs,
    model: request.model,
    provider: 'claude-cli',
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
// A free, fast probe (no model call / no token spend) that the app runs at startup
// and in the settings UI to confirm the claude-cli provider can actually be used:
// the binary must be on PATH and the user must be signed into their membership.

export interface ClaudeCliHealth {
  // True only when the CLI is installed AND a membership login is verified.
  ok: boolean
  installed: boolean
  version: string | null
  // 'yes' = verified signed in · 'no' = installed but not signed in ·
  // 'unknown' = can't tell (e.g. macOS Keychain stores the creds out of reach).
  authenticated: 'yes' | 'no' | 'unknown'
  subscriptionType: string | null
  message: string
}

// The service / target name Claude Code uses for its credential entry in the macOS
// Keychain and the Windows Credential Manager.
const CREDENTIAL_SERVICE = 'Claude Code-credentials'

interface OauthTokens {
  accessToken: string
  refreshToken: string
  subscriptionType?: string
}

// Outcome of looking for membership credentials in a given store:
//   found   — a valid OAuth token pair is present
//   absent  — the store was readable and definitively has no credentials (not signed in)
//   unknown — the store could not be consulted (tool missing, permission, etc.)
type OauthLookup =
  | { status: 'found'; tokens: OauthTokens }
  | { status: 'absent' }
  | { status: 'unknown' }

// Parse a raw `claudeAiOauth` credential blob (the JSON Claude Code stores). An
// expired accessToken is fine as long as a refreshToken exists — the CLI refreshes
// it automatically on the next call, so we only require both tokens to be present.
function parseOauthBlob(blob: string): OauthTokens | null {
  try {
    const oauth = (JSON.parse(blob) as { claudeAiOauth?: OauthTokens }).claudeAiOauth
    if (oauth?.accessToken && oauth?.refreshToken) return oauth
    return null
  } catch {
    return null
  }
}

// Run a command to completion, capturing stdout. Resolves to null if the binary
// can't be spawned (e.g. not installed); otherwise returns the exit code + stdout.
function runCapture(
  cmd: string,
  cmdArgs: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    // Fixed 'pipe','pipe','ignore' tuple so stdout/stdin type as non-null streams.
    const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout }))
    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

// `claude --version` → the version string, or null if the binary isn't runnable.
async function claudeVersion(): Promise<string | null> {
  const res = await runCapture('claude', ['--version'])
  return res && res.code === 0 ? res.stdout.trim() : null
}

// Linux/Windows default store: the plaintext ~/.claude/.credentials.json file.
async function readCredentialsFile(): Promise<OauthTokens | null> {
  try {
    return parseOauthBlob(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

// macOS: the login Keychain. `security` exits 44 when the item genuinely isn't there
// (→ absent); any other spawn/exec failure leaves us unable to tell (→ unknown).
async function readMacKeychain(): Promise<OauthLookup> {
  const res = await runCapture('security', ['find-generic-password', '-s', CREDENTIAL_SERVICE, '-w'])
  if (!res) return { status: 'unknown' }
  if (res.code === 44) return { status: 'absent' }
  if (res.code !== 0) return { status: 'unknown' }
  const tokens = parseOauthBlob(res.stdout.trim())
  return tokens ? { status: 'found', tokens } : { status: 'absent' }
}

// Windows: the Credential Manager, read via Win32 CredRead through PowerShell. The
// credential blob is emitted as base64 and decoded here, trying UTF-8 then UTF-16LE
// (different keyring versions store the secret in different encodings).
async function readWindowsCredential(): Promise<OauthLookup> {
  const ps = [
    '$ErrorActionPreference="Stop"',
    'try {',
    '$sig=@"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class CredApi {',
    '[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]',
    'public static extern bool CredRead(string target,int type,int flags,out IntPtr cred);',
    '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);',
    '[StructLayout(LayoutKind.Sequential)] public struct CREDENTIAL {',
    'public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;',
    'public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;',
    'public int Persist;public int AttributeCount;public IntPtr Attributes;',
    'public IntPtr TargetAlias;public IntPtr UserName; }',
    '}',
    '"@',
    'Add-Type $sig | Out-Null',
    '$p=[IntPtr]::Zero',
    `if([CredApi]::CredRead("${CREDENTIAL_SERVICE}",1,0,[ref]$p)){`,
    '$c=[System.Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][CredApi+CREDENTIAL])',
    '$b=New-Object byte[] $c.CredentialBlobSize',
    '[System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)',
    '[CredApi]::CredFree($p)',
    '[Convert]::ToBase64String($b)',
    '} else { exit 44 }',
    '} catch { exit 1 }',
  ].join('\n')

  const res = await runCapture(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', '-'],
    ps,
  )
  if (!res) return { status: 'unknown' }
  if (res.code === 44) return { status: 'absent' }
  if (res.code !== 0) return { status: 'unknown' }

  const raw = Buffer.from(res.stdout.trim(), 'base64')
  const tokens = parseOauthBlob(raw.toString('utf8')) ?? parseOauthBlob(raw.toString('utf16le'))
  return tokens ? { status: 'found', tokens } : { status: 'absent' }
}

// Resolve membership credentials from the right store for this platform. The file is
// always tried first (it's the default on Linux/Windows and sometimes present on
// macOS); the OS credential store is the fallback.
async function resolveMembershipOauth(): Promise<OauthLookup> {
  const fromFile = await readCredentialsFile()
  if (fromFile) return { status: 'found', tokens: fromFile }

  if (platform() === 'darwin') return readMacKeychain()
  if (platform() === 'win32') return readWindowsCredential()
  return { status: 'absent' } // Linux: the file was the only store and it had nothing.
}

export async function checkClaudeCli(): Promise<ClaudeCliHealth> {
  const version = await claudeVersion()
  if (version === null) {
    return {
      ok: false,
      installed: false,
      version: null,
      authenticated: 'unknown',
      subscriptionType: null,
      message:
        "The 'claude' CLI was not found on PATH. Install Claude Code, then run `claude` to sign in to your membership.",
    }
  }

  const lookup = await resolveMembershipOauth()

  if (lookup.status === 'found') {
    const sub = lookup.tokens.subscriptionType ?? null
    return {
      ok: true,
      installed: true,
      version,
      authenticated: 'yes',
      subscriptionType: sub,
      message: `Signed in to Claude membership${sub ? ` (${sub})` : ''}.`,
    }
  }

  if (lookup.status === 'unknown') {
    return {
      ok: false,
      installed: true,
      version,
      authenticated: 'unknown',
      subscriptionType: null,
      message:
        'Claude CLI is installed, but membership sign-in could not be verified (the OS credential store was unreadable). If reasoning calls fail, run `claude` and sign in.',
    }
  }

  return {
    ok: false,
    installed: true,
    version,
    authenticated: 'no',
    subscriptionType: null,
    message: 'Claude CLI is installed but not signed in. Run `claude` in a terminal and log in to your membership.',
  }
}
