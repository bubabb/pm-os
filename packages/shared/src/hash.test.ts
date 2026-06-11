import { describe, it, expect } from 'vitest'
import { stableHash } from './hash'

describe('stableHash', () => {
  it('returns a sha256 hex string', () => {
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is independent of object key order', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }))
  })

  it('is sensitive to array order', () => {
    expect(stableHash([1, 2, 3])).not.toBe(stableHash([3, 2, 1]))
  })

  it('is stable for nested structures regardless of key order', () => {
    const a = { outer: { x: [1, { deep: true, flag: null }], y: 'z' }, list: [1, 2] }
    const b = { list: [1, 2], outer: { y: 'z', x: [1, { flag: null, deep: true }] } }
    expect(stableHash(a)).toBe(stableHash(b))
  })

  it('produces different hashes for different content', () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }))
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ b: 1 }))
    expect(stableHash('1')).not.toBe(stableHash(1))
  })

  it('treats undefined object values as omitted, like JSON', () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }))
  })
})
