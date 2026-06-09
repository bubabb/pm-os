import type { ToolCase, ToolExecutor, RegressionReport, ToolCaseResult } from './types'

// Structural deep equality for tool outputs (order-sensitive for arrays/object keys).
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object)
    const bk = Object.keys(b as object)
    if (ak.length !== bk.length) return false
    return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

// Runs golden cases against a tool executor and reports pass/fail with diffs. A case
// whose matcher returns false, or whose executor throws, is a failure (not fatal).
export async function runToolRegression(
  meta: { tool: string; version: string },
  executor: ToolExecutor,
  cases: ToolCase[],
): Promise<RegressionReport> {
  const results: ToolCaseResult[] = []

  for (const c of cases) {
    const match = c.matcher ?? deepEqual
    let actual: unknown
    let passed = false
    let detail: string | undefined

    try {
      actual = await executor(c.input)
      passed = match(actual, c.expected)
      if (!passed) detail = `expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(actual)}`
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
    }

    results.push({ name: c.name, passed, actual, ...(detail !== undefined ? { detail } : {}) })
  }

  const passed = results.filter((r) => r.passed).length
  return {
    tool: meta.tool,
    version: meta.version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  }
}

// Validates that a tool version's `schema` field is well-formed JSON describing an object.
export function validateToolSchema(schemaJson: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(schemaJson)
  } catch {
    return { valid: false, errors: ['schema is not valid JSON'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push('schema must be a JSON object')
  }
  return { valid: errors.length === 0, errors }
}
