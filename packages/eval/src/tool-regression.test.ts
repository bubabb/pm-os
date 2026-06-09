import { describe, it, expect } from 'vitest'
import { runToolRegression, validateToolSchema, deepEqual } from './tool-regression'
import type { ToolCase, ToolExecutor } from './types'

// Stub executor under test: a "sum" tool taking { a, b } → number.
const sumTool: ToolExecutor = (input) => {
  const { a, b } = input as { a: number; b: number }
  return a + b
}

const cases: ToolCase[] = [
  { name: '2+2', input: { a: 2, b: 2 }, expected: 4 },
  { name: '0+0', input: { a: 0, b: 0 }, expected: 0 },
  { name: 'wrong', input: { a: 1, b: 1 }, expected: 3 }, // intentional failure
]

describe('deepEqual', () => {
  it('compares nested structures', () => {
    expect(deepEqual({ a: [1, 2], b: { c: 3 } }, { a: [1, 2], b: { c: 3 } })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })
})

describe('runToolRegression', () => {
  it('reports pass/fail per case with diffs', async () => {
    const report = await runToolRegression({ tool: 'sum', version: '1.0.0' }, sumTool, cases)
    expect(report.total).toBe(3)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(1)
    const failed = report.results.find((r) => !r.passed)
    expect(failed?.name).toBe('wrong')
    expect(failed?.detail).toContain('expected 3')
  })

  it('treats an executor throw as a failure', async () => {
    const boom: ToolExecutor = () => { throw new Error('tool crashed') }
    const report = await runToolRegression({ tool: 'x', version: '1' }, boom, [cases[0]!])
    expect(report.passed).toBe(0)
    expect(report.results[0]?.detail).toContain('tool crashed')
  })
})

describe('validateToolSchema', () => {
  it('accepts a JSON object', () => {
    expect(validateToolSchema('{"input":{}}').valid).toBe(true)
  })
  it('rejects invalid JSON and non-objects', () => {
    expect(validateToolSchema('not json').valid).toBe(false)
    expect(validateToolSchema('[1,2]').valid).toBe(false)
  })
})
