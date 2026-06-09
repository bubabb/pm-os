import { describe, it, expect } from 'vitest'
import { generateId } from './id'

describe('generateId', () => {
  it('returns a non-empty string', () => {
    expect(generateId()).toBeTypeOf('string')
    expect(generateId().length).toBeGreaterThan(0)
  })

  it('returns unique values across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()))
    expect(ids.size).toBe(1000)
  })
})
