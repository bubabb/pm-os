import Anthropic from '@anthropic-ai/sdk'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  ToolCall,
} from '../types'

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

// Translate one of our Messages into an Anthropic MessageParam. When a turn carries
// no tool calls/results it stays a plain-string content message (byte-for-byte the
// old behavior); a turn WITH tools is expanded into the Anthropic content-block form:
//   assistant toolCalls  → { type: 'tool_use',    id, name, input }
//   user      toolResults → { type: 'tool_result', tool_use_id, content, is_error }
// Text is preserved as a leading text block when present alongside tool blocks.
function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  const hasToolCalls = m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
  const hasToolResults = m.role === 'user' && m.toolResults && m.toolResults.length > 0

  if (!hasToolCalls && !hasToolResults) {
    return { role: m.role, content: m.content }
  }

  const blocks: Anthropic.ContentBlockParam[] = []
  if (m.content.length > 0) {
    blocks.push({ type: 'text', text: m.content })
  }
  if (hasToolCalls) {
    for (const call of m.toolCalls!) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
    }
  }
  if (hasToolResults) {
    for (const result of m.toolResults!) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError !== undefined ? { is_error: result.isError } : {}),
      })
    }
  }
  return { role: m.role, content: blocks }
}

// Map the Anthropic API `stop_reason` onto our provider-neutral value. `tool_use`
// passes through; both natural-stop reasons collapse to 'end'; `max_tokens` passes
// through. Server-side-tool reasons ('pause_turn') and 'refusal' fall back to 'end'
// — this provider does a single-shot text/tool-use turn, so they don't arise here.
function mapStopReason(
  reason: Anthropic.StopReason | null,
): 'end' | 'tool_use' | 'max_tokens' {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    default:
      return 'end'
  }
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
    messages: request.messages.map(toAnthropicMessage),
    ...(request.tools !== undefined && request.tools.length > 0
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
    ...(request.temperature !== undefined && !NO_SAMPLING_PARAMS.test(request.model)
      ? { temperature: request.temperature }
      : {}),
  })

  const durationMs = Date.now() - startMs
  const inputTokens  = response.usage.input_tokens
  const outputTokens = response.usage.output_tokens
  const content = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const toolCalls: ToolCall[] = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))

  return {
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: mapStopReason(response.stop_reason),
    inputTokens,
    outputTokens,
    costCents: calcCostCents(request.model, inputTokens, outputTokens),
    durationMs,
    model: request.model,
    provider: 'anthropic',
  }
}
