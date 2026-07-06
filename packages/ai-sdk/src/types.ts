export type ModelProvider = 'anthropic' | 'openai' | 'gemini' | 'claude-cli'

// A tool the model may call. `inputSchema` is a JSON Schema describing the tool's
// input object (e.g. `{ type: 'object', properties: {...}, required: [...] }`).
export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// A tool invocation the model requested. `id` correlates the call to its result.
export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

// The result of running a tool, fed back to the model on the next turn.
// `toolCallId` must match the `id` of the originating ToolCall.
export interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

export interface Message {
  role: 'user' | 'assistant'
  // Text content — kept as a plain string for backward compatibility. May be empty
  // on an assistant turn that only requested tools.
  content: string
  // Present on an assistant turn that requested tools.
  toolCalls?: ToolCall[]
  // Present on a user turn returning tool outputs for the assistant's prior calls.
  toolResults?: ToolResult[]
}

export interface CompletionRequest {
  provider: ModelProvider
  model: string
  messages: Message[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  // Tools the model may call this turn. Optional — omitting it preserves the
  // original text-only behavior. Only honored by providers where
  // `supportsTools(provider)` is true (currently 'anthropic'); ignored elsewhere.
  tools?: ToolSchema[]
}

export interface CompletionResponse {
  // Assistant text. May be empty when the model only requested tool calls.
  content: string
  // Tools the model wants to call this turn, if any.
  toolCalls?: ToolCall[]
  // Why the model stopped: 'end' (natural stop), 'tool_use' (wants tool results
  // back), or 'max_tokens' (hit the output cap).
  stopReason?: 'end' | 'tool_use' | 'max_tokens'
  inputTokens: number
  outputTokens: number
  costCents: number
  durationMs: number
  model: string
  provider: ModelProvider
}
