// AI SDK — model-agnostic wrapper
// Full implementation in Phase 1 Task #5
// Wraps: @anthropic-ai/sdk, openai, @google/generative-ai
// Exposes: @modelcontextprotocol/sdk

export type ModelProvider = 'anthropic' | 'openai' | 'gemini'

export interface ModelConfig {
  provider: ModelProvider
  model: string
  apiKey: string
}
