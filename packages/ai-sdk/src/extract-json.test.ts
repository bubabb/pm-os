import { describe, it, expect } from 'vitest'
import { extractJson } from './index'

describe('extractJson — tolerant model-JSON parsing', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips a ```json fence (what the claude-cli/membership model emits)', () => {
    const fenced = '```json\n{"bucket":"human","urgency":5}\n```'
    expect(extractJson(fenced)).toEqual({ bucket: 'human', urgency: 5 })
  })

  it('strips a bare ``` fence', () => {
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('recovers JSON embedded in surrounding prose', () => {
    const prose = 'Sure, here is the result:\n{"x":2}\nHope that helps!'
    expect(extractJson(prose)).toEqual({ x: 2 })
  })

  it('parses arrays', () => {
    expect(extractJson('```json\n[1,2,3]\n```')).toEqual([1, 2, 3])
  })

  it('throws when there is no JSON to find', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})
