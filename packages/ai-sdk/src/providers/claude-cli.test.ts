import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

// Mock the CLI spawn so the test is deterministic, offline, and spends no tokens —
// we only care about HOW the provider invokes claude (its cwd + args), not a real call.
const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { completeClaudeCli } from './claude-cli'

// A fake child process that emits the given stdout then closes, after the provider
// has synchronously attached its listeners.
function fakeChild(stdout: string, code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: (d: string) => void; end: () => void }
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // Real child stdin is a Writable stream (an EventEmitter) — the provider attaches
  // an 'error' listener to it, so the mock must be one too.
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() })
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdout))
    child.emit('close', code)
  })
  return child
}

const RESULT_JSON = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'NONE',
  total_cost_usd: 0.01,
  usage: { input_tokens: 9, output_tokens: 3 },
})

describe('claude-cli provider — neutral cwd isolation', () => {
  beforeEach(() => spawnMock.mockReset())

  it('spawns claude in a dedicated empty temp dir, not the process cwd', async () => {
    spawnMock.mockImplementation(() => fakeChild(RESULT_JSON))

    const res = await completeClaudeCli({
      provider: 'claude-cli',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const call = spawnMock.mock.calls.find((c) => c[0] === 'claude')
    expect(call).toBeDefined()
    const [, args, opts] = call as [string, string[], { cwd?: string }]

    const expectedCwd = join(tmpdir(), 'creare-ai-sdk-claude-cli')
    // Runs in the isolated dir — so no project/parent CLAUDE.md is auto-discovered.
    expect(opts.cwd).toBe(expectedCwd)
    expect(opts.cwd).not.toBe(process.cwd())
    // The isolated dir is real and empty — nothing for the CLI to pick up.
    expect(await readdir(expectedCwd)).toEqual([])
    // System prompt is forwarded and the result maps through.
    expect(args).toContain('--append-system-prompt')
    expect(res.content).toBe('NONE')
    expect(res.provider).toBe('claude-cli')
  })
})
