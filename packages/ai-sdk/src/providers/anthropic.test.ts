import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the Anthropic SDK so the tests are deterministic, offline, and spend no
// tokens. We only care about WHAT the provider sends to `messages.create` and HOW it
// parses the response — not a real network call. `createMock` is what each test
// programs with a canned response and later inspects for the request shape.
const createMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
    constructor(_opts: unknown) {}
  },
}))

import { completeAnthropic } from './anthropic'
import { supportsTools } from '../index'
import type { CompletionRequest } from '../types'

describe('supportsTools', () => {
  it('is true only for anthropic', () => {
    expect(supportsTools('anthropic')).toBe(true)
    expect(supportsTools('openai')).toBe(false)
    expect(supportsTools('gemini')).toBe(false)
    expect(supportsTools('claude-cli')).toBe(false)
  })
})

const baseRequest: Omit<CompletionRequest, 'messages'> = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
}

beforeEach(() => {
  createMock.mockReset()
})

describe('completeAnthropic — backward compatibility (text only)', () => {
  it('sends plain-string message content and parses text unchanged', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Paris' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    })

    const res = await completeAnthropic(
      { ...baseRequest, messages: [{ role: 'user', content: 'Capital of France?' }] },
      'test-key',
    )

    // Request shape: content is the plain string, no `tools` key at all.
    const params = createMock.mock.calls[0]![0]
    expect(params.messages).toEqual([{ role: 'user', content: 'Capital of France?' }])
    expect(params).not.toHaveProperty('tools')

    // Response: text extracted, stopReason mapped, no toolCalls key.
    expect(res.content).toBe('Paris')
    expect(res.stopReason).toBe('end')
    expect(res.toolCalls).toBeUndefined()
    expect(res.inputTokens).toBe(10)
    expect(res.outputTokens).toBe(2)
    expect(res.provider).toBe('anthropic')
    expect(res.model).toBe('claude-sonnet-4-6')
  })
})

describe('completeAnthropic — tool use', () => {
  it('maps tools to the Anthropic shape and parses a tool_use response', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'Let me check the weather.' },
        { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 40, output_tokens: 15 },
    })

    const res = await completeAnthropic(
      {
        ...baseRequest,
        messages: [{ role: 'user', content: "What's the weather in Paris?" }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
      'test-key',
    )

    // Request: our ToolSchema is mapped to {name, description, input_schema}.
    const params = createMock.mock.calls[0]![0]
    expect(params.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ])

    // Response: text + parsed toolCalls + stopReason 'tool_use'.
    expect(res.content).toBe('Let me check the weather.')
    expect(res.stopReason).toBe('tool_use')
    expect(res.toolCalls).toEqual([
      { id: 'toolu_123', name: 'get_weather', input: { city: 'Paris' } },
    ])
  })

  it('sends assistant toolCalls and user toolResults in the correct block shape', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'It is sunny in Paris.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 60, output_tokens: 8 },
    })

    const res = await completeAnthropic(
      {
        ...baseRequest,
        messages: [
          { role: 'user', content: "What's the weather in Paris?" },
          {
            role: 'assistant',
            content: 'Let me check the weather.',
            toolCalls: [{ id: 'toolu_123', name: 'get_weather', input: { city: 'Paris' } }],
          },
          {
            role: 'user',
            content: '',
            toolResults: [{ toolCallId: 'toolu_123', content: '{"tempC":22,"sky":"clear"}' }],
          },
        ],
      },
      'test-key',
    )

    const params = createMock.mock.calls[0]![0]
    expect(params.messages).toEqual([
      { role: 'user', content: "What's the weather in Paris?" },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check the weather.' },
          { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_123',
            content: '{"tempC":22,"sky":"clear"}',
          },
        ],
      },
    ])

    expect(res.content).toBe('It is sunny in Paris.')
    expect(res.stopReason).toBe('end')
  })

  it('carries is_error through on a failed tool result', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1 },
    })

    await completeAnthropic(
      {
        ...baseRequest,
        messages: [
          {
            role: 'user',
            content: '',
            toolResults: [
              { toolCallId: 'toolu_9', content: 'timeout', isError: true },
            ],
          },
        ],
      },
      'test-key',
    )

    const params = createMock.mock.calls[0]![0]
    expect(params.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_9',
      content: 'timeout',
      is_error: true,
    })
  })
})

describe('completeAnthropic — stop reason mapping', () => {
  it('maps max_tokens through', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 3, output_tokens: 100 },
    })

    const res = await completeAnthropic(
      { ...baseRequest, messages: [{ role: 'user', content: 'hi' }] },
      'test-key',
    )
    expect(res.stopReason).toBe('max_tokens')
  })
})
