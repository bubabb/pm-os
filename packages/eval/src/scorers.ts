import type { Scorer } from './types'

const norm = (s: string) => s.trim()

// Pass iff the output equals the case's expected value (whitespace-trimmed).
export const exactMatch: Scorer = (output, c) => {
  if (c.expected === undefined) return { score: 0, passed: false, detail: 'no expected value' }
  const ok = norm(output) === norm(c.expected)
  return { score: ok ? 1 : 0, passed: ok }
}

// Pass iff the output contains the expected value (case-insensitive substring).
export const includes: Scorer = (output, c) => {
  if (c.expected === undefined) return { score: 0, passed: false, detail: 'no expected value' }
  const ok = output.toLowerCase().includes(c.expected.toLowerCase())
  return { score: ok ? 1 : 0, passed: ok }
}

// Pass iff the output matches the given pattern.
export function regexMatch(pattern: RegExp): Scorer {
  return (output) => {
    const ok = pattern.test(output)
    return { score: ok ? 1 : 0, passed: ok }
  }
}
