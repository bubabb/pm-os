import { completeAnthropic } from './providers/anthropic'
import { completeOpenAI } from './providers/openai'
import { completeGemini } from './providers/gemini'
import { completeClaudeCli } from './providers/claude-cli'
import type { CompletionRequest, CompletionResponse, ModelProvider } from './types'

export type { CompletionRequest, CompletionResponse, Message, ModelProvider } from './types'
export { checkClaudeCli } from './providers/claude-cli'
export type { ClaudeCliHealth } from './providers/claude-cli'

// Whether a provider authenticates with a per-call API key. `claude-cli` is the
// exception — it uses the local Claude membership login and needs no key.
export function providerNeedsKey(provider: ModelProvider): boolean {
  return provider !== 'claude-cli'
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
