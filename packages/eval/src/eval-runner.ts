import type { EvalCase, Scorer, ModelRunner, EvalRunSummary, EvalCaseResult } from './types'

// Runs each case through the runner, scores the output, and aggregates. A runner or
// scorer that throws fails that case (captured in `detail`) without aborting the run.
export async function runEval(
  suite: string,
  cases: EvalCase[],
  runner: ModelRunner,
  scorer: Scorer,
): Promise<EvalRunSummary> {
  const results: EvalCaseResult[] = []

  for (const c of cases) {
    const start = Date.now()
    let output = ''
    let score = 0
    let passed = false
    let detail: string | undefined

    try {
      output = await runner(c.input)
      const r = await scorer(output, c)
      score = r.score
      passed = r.passed
      detail = r.detail
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
    }

    results.push({
      caseId: c.id,
      output,
      score,
      passed,
      durationMs: Date.now() - start,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  const passedCount = results.filter((r) => r.passed).length
  const avgScore = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0

  return {
    suite,
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    passRate: results.length ? passedCount / results.length : 0,
    avgScore,
    results,
  }
}
