import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import { assertProjectAccess } from '../utils/project-access'
import { resolveReasoningConfig, providerNeedsKey } from '../secrets'
import type { AuthenticatedRequest } from '../auth'
import {
  runEval, persistEvalRun, listEvalRuns,
  exactMatch, includes, regexMatch, makeModelRunner, makeLlmJudge,
} from '@pm-os/eval'
import type { EvalCase, Scorer } from '@pm-os/eval'

interface ProjectParams { id: string }
interface ListRunsQuery { suite?: string }

type ScorerKind = 'exact' | 'includes' | 'regex' | 'llm_judge'

interface RunEvalBody {
  suite: string
  cases: EvalCase[]
  scorer: ScorerKind
  pattern?: string                       // required when scorer === 'regex'
  systemPrompt?: string
}

const SCORER_KINDS: ScorerKind[] = ['exact', 'includes', 'regex', 'llm_judge']

// Validates the POST body shape; returns an error message or null when valid.
function validateRunEvalBody(b: RunEvalBody): string | null {
  if (!b || typeof b.suite !== 'string' || !b.suite.trim()) return 'Missing suite'
  if (!Array.isArray(b.cases) || b.cases.length === 0) return 'cases must be a non-empty array'
  for (const c of b.cases) {
    if (!c || typeof c.id !== 'string' || !c.id || typeof c.input !== 'string') {
      return 'Each case requires string id and input'
    }
  }
  if (!SCORER_KINDS.includes(b.scorer)) return `scorer must be one of: ${SCORER_KINDS.join(', ')}`
  if (b.scorer === 'regex') {
    if (typeof b.pattern !== 'string' || !b.pattern) return 'regex scorer requires a pattern'
    try { new RegExp(b.pattern) } catch { return 'Invalid regex pattern' }
  }
  return null
}

export async function evalRoutes(app: FastifyInstance): Promise<void> {
  // List past eval runs for a project (newest first), optionally filtered to one suite.
  app.get<{ Params: ProjectParams; Querystring: ListRunsQuery }>(
    '/projects/:id/eval-runs',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Querystring: ListRunsQuery }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })
      return listEvalRuns(request.params.id, request.query.suite)
    },
  )

  // Run an eval suite against the workspace's default reasoning model and persist
  // the result. The eval package writes the append-only event-log entry itself.
  app.post<{ Params: ProjectParams; Body: RunEvalBody }>(
    '/projects/:id/eval-runs',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: ProjectParams; Body: RunEvalBody }>, reply) => {
      const user = (request as AuthenticatedRequest).user
      if (!await assertProjectAccess(request.params.id, user.id)) return reply.code(404).send({ error: 'Not found' })

      const invalid = validateRunEvalBody(request.body)
      if (invalid) return reply.code(400).send({ error: invalid })

      const { apiKey, provider, model } = await resolveReasoningConfig()
      if (providerNeedsKey(provider) && !apiKey) {
        return reply.code(422).send({ error: `${provider.toUpperCase()}_API_KEY not configured` })
      }

      const { suite, cases, systemPrompt } = request.body
      const runner = makeModelRunner(
        { provider, model, ...(systemPrompt !== undefined ? { systemPrompt } : {}) },
        apiKey,
      )

      let scorer: Scorer
      switch (request.body.scorer) {
        case 'exact':     scorer = exactMatch; break
        case 'includes':  scorer = includes; break
        case 'regex':     scorer = regexMatch(new RegExp(request.body.pattern!)); break
        case 'llm_judge': scorer = makeLlmJudge({ provider, model }, apiKey); break
      }

      try {
        const summary = await runEval(suite.trim(), cases, runner, scorer)
        return persistEvalRun(request.params.id, `${provider}:${model}`, summary)
      } catch {
        return reply.code(500).send({ error: 'Eval run failed' })
      }
    },
  )
}
