import { completeAnthropic } from './providers/anthropic'
import { completeOpenAI } from './providers/openai'
import { completeGemini } from './providers/gemini'
import type { CompletionRequest, CompletionResponse } from './types'

export type { CompletionRequest, CompletionResponse, Message, ModelProvider } from './types'

export async function complete(
  request: CompletionRequest,
  apiKey: string,
): Promise<CompletionResponse> {
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
