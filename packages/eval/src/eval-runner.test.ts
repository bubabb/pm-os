import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { seedWorkspace, destroyTestDb } from '@pm-os/database/testing'
import { runEval } from './eval-runner'
import { exactMatch } from './scorers'
import { persistEvalRun, listEvalRuns } from './persistence'
import type { EvalCase, ModelRunner } from './types'

const cases: EvalCase[] = [
  { id: 'a', input: 'echo:hello', expected: 'hello' },
  { id: 'b', input: 'echo:world', expected: 'NOPE' },
]

// Stub runner: returns the text after "echo:".
const echoRunner: ModelRunner = async (input) => input.replace(/^echo:/, '')

describe('runEval', () => {
  it('aggregates pass/fail and average score', async () => {
    const summary = await runEval('demo', cases, echoRunner, exactMatch)
    expect(summary.total).toBe(2)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.passRate).toBe(0.5)
    expect(summary.avgScore).toBe(0.5)
    expect(summary.results[0]?.passed).toBe(true)
  })

  it('captures a thrown runner error as a failed case', async () => {
    const boom: ModelRunner = async () => { throw new Error('runner exploded') }
    const summary = await runEval('demo', [cases[0]!], boom, exactMatch)
    expect(summary.passed).toBe(0)
    expect(summary.results[0]?.detail).toContain('runner exploded')
  })
})

describe('eval persistence', () => {
  let projectId: string
  beforeEach(() => { ({ projectId } = seedWorkspace()) })
  afterEach(() => destroyTestDb())

  it('persists a run and lists it back', async () => {
    const summary = await runEval('regression', cases, echoRunner, exactMatch)
    persistEvalRun(projectId, 'stub', summary)
    const runs = listEvalRuns(projectId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.suite).toBe('regression')
    expect(runs[0]?.passed).toBe(1)
    expect(JSON.parse(runs[0]!.results)).toHaveLength(2)
  })
})
