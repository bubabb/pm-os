# Agent Task: Phase 2 — AI SDK Anthropic Wrapper

---
status: ready
phase: 2
task-id: 20
blocked-by: []
---

## Before You Start
Read in order:
1. `/project-scope.md` §7 (design principles — model-agnostic)
2. `/packages/ai-sdk/CLAUDE.md`
3. `/packages/ai-sdk/src/index.ts` — current stub

## Your Scope
You own: `packages/ai-sdk/src/**`

## What You Must Produce

### 1. Core types (`src/types.ts`)
```typescript
type ModelProvider = 'anthropic' | 'openai' | 'gemini'

interface CompletionRequest {
  provider: ModelProvider
  model: string
  messages: Message[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
}

interface CompletionResponse {
  content: string
  inputTokens: number
  outputTokens: number
  costCents: number   // calculated from provider pricing
  durationMs: number
  model: string
  provider: ModelProvider
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}
```

### 2. Anthropic provider (`src/providers/anthropic.ts`)
- Wraps `@anthropic-ai/sdk`
- `complete(request: CompletionRequest): Promise<CompletionResponse>`
- Model: default to `claude-sonnet-4-6`
- Cost calculation: input $3/Mtok, output $15/Mtok (Sonnet 4.6 pricing)
- Handles API errors with descriptive messages

### 3. Public index (`src/index.ts`)
- Export `complete(request: CompletionRequest): Promise<CompletionResponse>`
- Routes to correct provider based on `request.provider`
- Re-exports all types

## Done When
- [ ] `complete()` calls Anthropic API and returns structured response
- [ ] Cost calculated correctly in cents
- [ ] TypeScript compiles with zero errors
