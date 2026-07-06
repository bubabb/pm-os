import { getDb, evalRuns, events } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
import { and, eq, desc } from 'drizzle-orm'
import type { EvalRun } from '@pm-os/database'
import type { EvalRunSummary } from './types'

// Persists an eval run so pass rates can be tracked over time. `runner` records how
// outputs were produced, e.g. "anthropic:claude-sonnet-4-6" or "stub".
export function persistEvalRun(projectId: string, runner: string, summary: EvalRunSummary): EvalRun {
  const id = generateId()
  getDb()
    .insert(evalRuns)
    .values({
      id,
      projectId,
      suite: summary.suite,
      runner,
      total: summary.total,
      passed: summary.passed,
      passRate: summary.passRate,
      avgScore: summary.avgScore,
      results: JSON.stringify(summary.results),
    })
    .run()
  // Append-only event log — every state change is an event (CLAUDE.md rule 2).
  getDb().insert(events).values({
    id: generateId(),
    type: 'eval_run.persisted',
    domain: 'eval',
    projectId,
    actorType: 'system',
    actorId: null,
    resourceType: 'eval_run',
    resourceId: id,
    payload: JSON.stringify({ suite: summary.suite, runner, passRate: summary.passRate }),
  }).run()
  return getDb().select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1).all()[0]!
}

// Lists past eval runs for a project (newest first), optionally filtered to one suite.
export function listEvalRuns(projectId: string, suite?: string): EvalRun[] {
  const db = getDb()
  const where = suite
    ? and(eq(evalRuns.projectId, projectId), eq(evalRuns.suite, suite))
    : eq(evalRuns.projectId, projectId)
  return db.select().from(evalRuns).where(where).orderBy(desc(evalRuns.createdAt)).all()
}
