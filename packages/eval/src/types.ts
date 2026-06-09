// ── AI eval ──────────────────────────────────────────────────────────────────

export interface EvalCase {
  id: string
  input: string                          // single-turn user prompt
  expected?: string                      // for exact/includes/regex scorers
  rubric?: string                        // for the LLM-as-judge scorer
  metadata?: Record<string, unknown>
}

export interface ScoreResult {
  score: number                          // 0..1
  passed: boolean
  detail?: string
}

// A scorer grades an output against its case. May be sync or async (LLM judges).
export type Scorer = (output: string, evalCase: EvalCase) => ScoreResult | Promise<ScoreResult>

// A runner produces a model output for a case input.
export type ModelRunner = (input: string) => Promise<string>

export interface EvalCaseResult {
  caseId: string
  output: string
  score: number
  passed: boolean
  durationMs: number
  detail?: string
}

export interface EvalRunSummary {
  suite: string
  total: number
  passed: number
  failed: number
  passRate: number                       // 0..1
  avgScore: number                       // 0..1
  results: EvalCaseResult[]
}

// ── Tool regression ───────────────────────────────────────────────────────────

// A tool executor runs a tool implementation against an input. No execution engine
// exists yet, so callers supply one (or a stub) — the harness is ready for when it lands.
export type ToolExecutor = (input: unknown) => unknown | Promise<unknown>

export interface ToolCase {
  name: string
  input: unknown
  expected: unknown
  matcher?: (actual: unknown, expected: unknown) => boolean   // defaults to deepEqual
}

export interface ToolCaseResult {
  name: string
  passed: boolean
  actual: unknown
  detail?: string
}

export interface RegressionReport {
  tool: string
  version: string
  total: number
  passed: number
  failed: number
  results: ToolCaseResult[]
}
