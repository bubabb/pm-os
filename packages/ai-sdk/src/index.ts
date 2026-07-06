import { completeAnthropic } from './providers/anthropic'
import { completeOpenAI } from './providers/openai'
import { completeGemini } from './providers/gemini'
import { completeClaudeCli } from './providers/claude-cli'
import type { CompletionRequest, CompletionResponse, ModelProvider } from './types'

export type {
  CompletionRequest,
  CompletionResponse,
  Message,
  ModelProvider,
  ToolSchema,
  ToolCall,
  ToolResult,
} from './types'
export { checkClaudeCli } from './providers/claude-cli'
export type { ClaudeCliHealth } from './providers/claude-cli'

// Whether a provider authenticates with a per-call API key. `claude-cli` is the
// exception — it uses the local Claude membership login and needs no key.
export function providerNeedsKey(provider: ModelProvider): boolean {
  return provider !== 'claude-cli'
}

// Whether a provider supports native tool use (function calling) through this SDK.
// Only 'anthropic' does today; the runtime uses this to decide between a tool loop
// and a single-shot text call. Passing `tools` to any other provider is ignored,
// not an error.
export function supportsTools(provider: ModelProvider): boolean {
  return provider === 'anthropic'
}

// Parse JSON out of a model response, tolerating the formatting models add even when
// asked for "JSON only" — most notably ```json fences (the claude-cli/membership
// model wraps its output this way) and the odd line of surrounding prose. Use this
// instead of JSON.parse(response.content) anywhere a model is prompted for JSON.
export function extractJson<T = unknown>(content: string): T {
  let s = content.trim()
  // Strip a fenced block: ```json\n…\n``` or ```\n…\n```.
  const fence = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) s = fence[1]!.trim()
  try {
    return JSON.parse(s) as T
  } catch {
    // Fall back to the outermost {…} / […] span in case of stray prose around it.
    const start = s.search(/[{[]/)
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
    if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1)) as T
    throw new Error('No JSON found in model response')
  }
}

// Whether the model is actually callable given the configured auth: keyed providers
// need a non-empty key; claude-cli is always callable via the membership login.
// Use this instead of testing the API key's truthiness directly.
export function llmAvailable(provider: ModelProvider, apiKey: string | null): boolean {
  return providerNeedsKey(provider) ? !!apiKey : true
}

export async function complete(
  request: CompletionRequest,
  // Optional: the `claude-cli` provider authenticates via the Claude membership
  // login and needs no key. The API-key providers below require it.
  apiKey?: string,
): Promise<CompletionResponse> {
  if (request.provider === 'claude-cli') {
    return completeClaudeCli(request)
  }

  if (apiKey === undefined) {
    throw new Error(`Provider '${request.provider}' requires an API key`)
  }

  switch (request.provider) {
    case 'anthropic':
      return completeAnthropic(request, apiKey)
    case 'openai':
      return completeOpenAI(request, apiKey)
    case 'gemini':
      return completeGemini(request, apiKey)
    default:
      throw new Error(`Provider '${request.provider}' not yet implemented`)
  }
}
