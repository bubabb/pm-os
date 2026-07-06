import { GoogleGenerativeAI } from '@google/generative-ai'
import type { Content } from '@google/generative-ai'
import type { CompletionRequest, CompletionResponse } from '../types'

// Gemini pricing (per million tokens, in USD → cents)
// approximate public pricing; verify
const PRICING: Record<string, { inputCentsPerMtok: number; outputCentsPerMtok: number }> = {
  'gemini-2.0-flash':   { inputCentsPerMtok: 10,  outputCentsPerMtok: 40  },
  'gemini-1.5-pro':     { inputCentsPerMtok: 125, outputCentsPerMtok: 500 },
}

function calcCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? PRICING['gemini-2.0-flash']!
  const inputCents  = (inputTokens  / 1_000_000) * pricing.inputCentsPerMtok
  const outputCents = (outputTokens / 1_000_000) * pricing.outputCentsPerMtok
  // Rounded (not ceil'd) to the nearest cent — cost_cents is an integer column, so
  // sub-cent precision is inherently lost here. Rounding halves the systematic
  // over-reporting bias that Math.ceil introduced; true sub-cent accuracy would
  // require a schema change to a micro-cents unit.
  return Math.round(inputCents + outputCents)
}

// Rough fallback when the countTokens API is unavailable: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export async function completeGemini(
  request: CompletionRequest,
  apiKey: string,
): Promise<CompletionResponse> {
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: request.model })
  const startMs = Date.now()

  // SDK 0.3.x has no `systemInstruction` — prepend the system prompt to the
  // first user message instead.
  let systemPrepended = false
  const contents: Content[] = request.messages.map((m) => {
    let text = m.content
    if (!systemPrepended && m.role === 'user' && request.systemPrompt !== undefined) {
      text = `${request.systemPrompt}\n\n${text}`
      systemPrepended = true
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] }
  })

  const result = await model.generateContent({
    contents,
    generationConfig: {
      maxOutputTokens: request.maxTokens ?? 1024,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  })

  const durationMs = Date.now() - startMs
  const content = result.response.text()

  // SDK 0.3.x exposes no usageMetadata on the response — count tokens via the
  // API, falling back to a character-based estimate on failure.
  const promptText = contents
    .map((c) => c.parts.map((p) => ('text' in p ? p.text : '')).join(''))
    .join('')
  const [inputTokens, outputTokens] = await Promise.all([
    model
      .countTokens({ contents })
      .then((r) => r.totalTokens)
      .catch(() => estimateTokens(promptText)),
    content.length > 0
      ? model
          .countTokens(content)
          .then((r) => r.totalTokens)
          .catch(() => estimateTokens(content))
      : Promise.resolve(0),
  ])

  return {
    content,
    inputTokens,
    outputTokens,
    costCents: calcCostCents(request.model, inputTokens, outputTokens),
    durationMs,
    model: request.model,
    provider: 'gemini',
  }
}
