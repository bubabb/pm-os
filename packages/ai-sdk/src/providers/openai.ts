import OpenAI from 'openai'
import type { CompletionRequest, CompletionResponse } from '../types'

// OpenAI pricing (per million tokens, in USD → cents)
// approximate public pricing; verify
const PRICING: Record<string, { inputCentsPerMtok: number; outputCentsPerMtok: number }> = {
  'gpt-4o':      { inputCentsPerMtok: 250, outputCentsPerMtok: 1000 },
  'gpt-4o-mini': { inputCentsPerMtok: 15,  outputCentsPerMtok: 60   },
}

function calcCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? PRICING['gpt-4o']!
  const inputCents  = (inputTokens  / 1_000_000) * pricing.inputCentsPerMtok
  const outputCents = (outputTokens / 1_000_000) * pricing.outputCentsPerMtok
  // Rounded (not ceil'd) to the nearest cent — cost_cents is an integer column, so
  // sub-cent precision is inherently lost here. Rounding halves the systematic
  // over-reporting bias that Math.ceil introduced; true sub-cent accuracy would
  // require a schema change to a micro-cents unit.
  return Math.round(inputCents + outputCents)
}

export async function completeOpenAI(
  request: CompletionRequest,
  apiKey: string,
): Promise<CompletionResponse> {
  const client = new OpenAI({ apiKey })
  const startMs = Date.now()

  // OpenAI has no top-level system param — the system prompt is the first message
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    ...(request.systemPrompt !== undefined
      ? [{ role: 'system' as const, content: request.systemPrompt }]
      : []),
    ...request.messages.map((m) => ({ role: m.role, content: m.content })),
  ]

  const response = await client.chat.completions.create({
    model: request.model,
    max_tokens: request.maxTokens ?? 1024,
    messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  })

  const durationMs = Date.now() - startMs
  const inputTokens  = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const content = response.choices[0]?.message?.content ?? ''

  return {
    content,
    inputTokens,
    outputTokens,
    costCents: calcCostCents(request.model, inputTokens, outputTokens),
    durationMs,
    model: request.model,
    provider: 'openai',
  }
}
