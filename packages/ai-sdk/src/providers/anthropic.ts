import Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest, CompletionResponse } from '../types'

// Anthropic pricing (per million tokens, in USD → cents)
const PRICING: Record<string, { inputCentsPerMtok: number; outputCentsPerMtok: number }> = {
  'claude-sonnet-4-6':           { inputCentsPerMtok: 300, outputCentsPerMtok: 1500 },
  'claude-opus-4-8':             { inputCentsPerMtok: 500, outputCentsPerMtok: 2500 },
  'claude-haiku-4-5-20251001':   { inputCentsPerMtok: 100, outputCentsPerMtok: 500  },
}

// Models that REJECT sampling params — sending `temperature`/`top_p` to these
// returns HTTP 400 (Opus 4.7/4.8 and Fable 5 removed sampling params).
const NO_SAMPLING_PARAMS = /claude-opus-4-(7|8)|claude-fable-5/

function calcCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? PRICING['claude-sonnet-4-6']!
  const inputCents  = (inputTokens  / 1_000_000) * pricing.inputCentsPerMtok
  const outputCents = (outputTokens / 1_000_000) * pricing.outputCentsPerMtok
  // Rounded (not ceil'd) to the nearest cent — cost_cents is an integer column, so
  // sub-cent precision is inherently lost here. Rounding halves the systematic
  // over-reporting bias that Math.ceil introduced; true sub-cent accuracy would
  // require a schema change to a micro-cents unit.
  return Math.round(inputCents + outputCents)
}

export async function completeAnthropic(
  request: CompletionRequest,
  apiKey: string,
): Promise<CompletionResponse> {
  const client = new Anthropic({ apiKey })
  const startMs = Date.now()

  const response = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens ?? 1024,
    ...(request.systemPrompt !== undefined ? { system: request.systemPrompt } : {}),
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(request.temperature !== undefined && !NO_SAMPLING_PARAMS.test(request.model)
      ? { temperature: request.temperature }
      : {}),
  })

  const durationMs = Date.now() - startMs
  const inputTokens  = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')

  return {
    content,
    inputTokens,
    outputTokens,
    costCents: calcCostCents(request.model, inputTokens, outputTokens),
    durationMs,
    model: request.model,
    provider: 'anthropic',
  }
}
