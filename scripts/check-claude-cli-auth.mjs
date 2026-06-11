// Dev diagnostic for the membership-backed `claude-cli` reasoning provider.
//
// Prints (a) the canonical health result the app uses (checkClaudeCli from
// @creare/ai-sdk) and (b) a per-store breakdown that reveals WHERE the membership
// credential actually lives and under WHAT entry name — so you can confirm or fix
// the `CREDENTIAL_SERVICE` constant in packages/ai-sdk/src/providers/claude-cli.ts
// on macOS (Keychain) and Windows (Credential Manager).
//
// Usage:  pnpm check:auth     (or)     node scripts/check-claude-cli-auth.mjs
// Reads only — never writes, never makes a model call, never spends tokens.
import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir, platform } from 'os'
import { join } from 'path'

// Entry names Claude Code might use for its credential in the OS store. The first is
// what claude-cli.ts currently assumes; the rest are plausible variants to probe.
const CANDIDATE_NAMES = [
  'Claude Code-credentials',
  'Claude Code',
  'claude-code',
  'claude',
]

const ok = (s) => `\x1b[32m${s}\x1b[0m`
const bad = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const head = (s) => `\n\x1b[1m${s}\x1b[0m`

// Run a command, capturing stdout. Returns { code, stdout } — code 127 means the
// binary couldn't be spawned at all (treated as "tool unavailable").
function run(cmd, args, input) {
  try {
    const stdout = execFileSync(cmd, args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 127, stdout: e.stdout?.toString?.() ?? '' }
  }
}

// Pull the claudeAiOauth token pair out of a raw credential blob, if present.
function parseOauth(blob) {
  try {
    const o = JSON.parse(blob)?.claudeAiOauth
    return o?.accessToken && o?.refreshToken ? o : null
  } catch {
    return null
  }
}

function describeTokens(o) {
  return `${ok('FOUND')}  sub=${o.subscriptionType ?? '?'}  ` +
    dim(`accessToken=${o.accessToken.slice(0, 6)}…  refreshToken=${o.refreshToken.slice(0, 6)}…`)
}

console.log(head('Environment'))
console.log(`  platform: ${platform()}`)
const ver = run('claude', ['--version'])
console.log(`  claude  : ${ver.code === 0 ? ver.stdout.trim() : bad('not found on PATH')}`)

// ── Store 1: credentials file (Linux/Windows default; sometimes macOS) ──────────
console.log(head('Store: ~/.claude/.credentials.json (file)'))
const credPath = join(homedir(), '.claude', '.credentials.json')
if (!existsSync(credPath)) {
  console.log(`  ${dim('absent')}  ${credPath}`)
} else {
  const tokens = parseOauth(readFileSync(credPath, 'utf8'))
  console.log(`  ${credPath}`)
  console.log(`  ${tokens ? describeTokens(tokens) : bad('present but no claudeAiOauth tokens')}`)
}

// ── Store 2: macOS Keychain ─────────────────────────────────────────────────────
if (platform() === 'darwin') {
  console.log(head('Store: macOS Keychain (security find-generic-password)'))
  for (const name of CANDIDATE_NAMES) {
    const r = run('security', ['find-generic-password', '-s', name, '-w'])
    if (r.code === 0) {
      const tokens = parseOauth(r.stdout.trim())
      console.log(`  -s ${JSON.stringify(name)} → ${tokens ? describeTokens(tokens) : ok('matched') + dim(' (blob not JSON oauth)')}`)
    } else if (r.code === 44) {
      console.log(`  -s ${JSON.stringify(name)} → ${dim('not found (exit 44)')}`)
    } else {
      console.log(`  -s ${JSON.stringify(name)} → ${bad(`error (exit ${r.code})`)}`)
    }
  }
  console.log(dim('  → whichever name shows FOUND is what CREDENTIAL_SERVICE should be.'))
}

// ── Store 3: Windows Credential Manager ─────────────────────────────────────────
if (platform() === 'win32') {
  console.log(head('Store: Windows Credential Manager (cmdkey /list)'))
  const list = run('cmdkey', ['/list'])
  const claudeLines = list.stdout.split(/\r?\n/).filter((l) => /claude/i.test(l)).map((l) => l.trim())
  if (claudeLines.length === 0) {
    console.log(`  ${dim('no targets matching /claude/i')}`)
  } else {
    console.log('  matching targets (the part after "target=" is CREDENTIAL_SERVICE):')
    for (const l of claudeLines) console.log(`    ${ok(l)}`)
  }
  console.log(dim('  Note: cmdkey lists targets but not the secret; the app reads the secret'))
  console.log(dim('        via Win32 CredRead. Use the Target name above to set CREDENTIAL_SERVICE.'))
}

// ── Canonical result the app actually uses ──────────────────────────────────────
console.log(head('checkClaudeCli() — the result the app/UI sees'))
try {
  const { checkClaudeCli } = await import(new URL('../packages/ai-sdk/dist/index.js', import.meta.url))
  const health = await checkClaudeCli()
  const line = health.ok ? ok('ok') : health.authenticated === 'unknown' ? dim('unknown') : bad('not ok')
  console.log(`  status: ${line}`)
  console.log(`  ${JSON.stringify(health, null, 2).split('\n').join('\n  ')}`)
} catch (e) {
  console.log(`  ${bad('could not load @creare/ai-sdk dist')} — run: pnpm --filter @creare/ai-sdk build`)
  console.log(`  ${dim(e.message)}`)
}
console.log()
