import { describe, it, expect } from 'vitest'
import { exactMatch, includes, regexMatch } from './scorers'
import type { EvalCase } from './types'

const mkCase = (expected?: string): EvalCase => ({ id: 'c1', input: 'q', ...(expected !== undefined ? { expected } : {}) })

describe('scorers', () => {
  it('exactMatch passes on trimmed equality', async () => {
    expect((await exactMatch('  hello ', mkCase('hello'))).passed).toBe(true)
    expect((await exactMatch('hi', mkCase('hello'))).passed).toBe(false)
  })

  it('exactMatch fails gracefully with no expected value', async () => {
    const r = await exactMatch('hello', mkCase())
    expect(r.passed).toBe(false)
    expect(r.detail).toBeTruthy()
  })

  it('includes does case-insensitive substring match', async () => {
    expect((await includes('The Answer is 42', mkCase('answer'))).passed).toBe(true)
    expect((await includes('nope', mkCase('answer'))).passed).toBe(false)
  })

  it('regexMatch honors the pattern', async () => {
    const scorer = regexMatch(/\d{3}-\d{4}/)
    expect((await scorer('call 555-1234', mkCase())).passed).toBe(true)
    expect((await scorer('no number', mkCase())).passed).toBe(false)
  })
})
