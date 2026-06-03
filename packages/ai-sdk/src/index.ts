import { completeAnthropic } from './providers/anthropic'
import type { CompletionRequest, CompletionResponse } from './types'

export type { CompletionRequest, CompletionResponse, Message, ModelProvider } from './types'

export async function complete(
  request: CompletionRequest,
  apiKey: string,
): Promise<CompletionResponse> {
  switch (request.provider) {
    case 'anthropic':
      return completeAnthropic(request, apiKey)
    default:
      throw new Error(`Provider '${request.provider}' not yet implemented`)
  }
}
