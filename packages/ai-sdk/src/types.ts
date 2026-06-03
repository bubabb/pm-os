export type ModelProvider = 'anthropic' | 'openai' | 'gemini'

export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface CompletionRequest {
  provider: ModelProvider
  model: string
  messages: Message[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
}

export interface CompletionResponse {
  content: string
  inputTokens: number
  outputTokens: number
  costCents: number
  durationMs: number
  model: string
  provider: ModelProvider
}
