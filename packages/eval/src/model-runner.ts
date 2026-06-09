import { complete } from '@creare/ai-sdk'
import type { ModelProvider } from '@creare/ai-sdk'
import type { ModelRunner, Scorer } from './types'

// Builds a ModelRunner that sends each case input as a single user message through
// the model-agnostic ai-sdk. Requires a live API key — used by real eval runs, not
// by the package's own unit tests (which use stub runners).
export function makeModelRunner(
  opts: { provider: ModelProvider; model: string; systemPrompt?: string; temperature?: number; maxTokens?: number },
  apiKey: string,
): ModelRunner {
  return async (input: string) => {
    const res = await complete(
      {
        provider: opts.provider,
        model: opts.model,
        messages: [{ role: 'user', content: input }],
        ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      },
      apiKey,
    )
    return res.content
  }
}

// LLM-as-judge scorer: asks a judge model whether the output satisfies the case's
// rubric (or expected value), returning a binary pass/fail.
export function makeLlmJudge(opts: { provider: ModelProvider; model: string }, apiKey: string): Scorer {
  return async (output, c) => {
    const rubric =
      c.rubric ??
      (c.expected !== undefined
        ? `The answer should match: ${c.expected}`
        : 'The answer should be correct, relevant, and complete.')

    const res = await complete(
      {
        provider: opts.provider,
        model: opts.model,
        systemPrompt: 'You are a strict evaluator. Reply with a single token: PASS or FAIL.',
        messages: [
          {
            role: 'user',
            content: `Rubric:\n${rubric}\n\nAnswer:\n${output}\n\nDoes the answer satisfy the rubric? Reply PASS or FAIL.`,
          },
        ],
        maxTokens: 5,
        temperature: 0,
      },
      apiKey,
    )

    const passed = /pass/i.test(res.content)
    return { score: passed ? 1 : 0, passed, detail: res.content.trim() }
  }
}
