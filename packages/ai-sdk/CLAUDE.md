# Package: AI SDK
---
status: active
version: 1.0
last-updated: 2026-06-02
---

## What This Package Does
The model-agnostic wrapper over Anthropic, OpenAI, and Gemini SDKs. One interface to call any model. Handles message formats, tool-calling schemas, streaming, rate limits, and error normalization across providers. Also exposes the MCP TypeScript SDK for external tool connectivity.

## Critical Rules
- Zero provider lock-in — the public API must never expose provider-specific types
- All model calls go through this package — no domain imports @anthropic-ai/sdk directly
- Streaming is first-class — all completions support both streaming and non-streaming
- Every call emits cost and latency metadata for the observability domain

## Files You Own
- `packages/ai-sdk/src/**`

## Consumed By
- `packages/agent-orchestration` — agent task execution
- `packages/reporting` — NL query processing, summary generation
