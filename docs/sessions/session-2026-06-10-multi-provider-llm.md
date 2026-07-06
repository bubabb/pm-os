# Session Log — 2026-06-10 — Multi-provider LLM support (OpenAI + Gemini + default reasoning model)

## Context
Pm.Os was Anthropic-only at runtime (ai-sdk `complete()` threw for openai/gemini; every PM
call site hardcoded `'anthropic'` + `'claude-haiku-4-5-20251001'`). This pass makes the
platform usable with whichever provider the user picks, end-to-end.

## ai-sdk (packages/ai-sdk)
- New `src/providers/openai.ts` — `completeOpenAI()` via `openai` SDK (`chat.completions.create`).
  System prompt prepended as a `role:'system'` message (OpenAI has no top-level system param).
  Tokens from `usage.prompt_tokens`/`completion_tokens`. Pricing table (cents/MTok, approximate
  public pricing; verify): gpt-4o 250/1000, gpt-4o-mini 15/60; fallback = gpt-4o.
- New `src/providers/gemini.ts` — `completeGemini()` via `@google/generative-ai` **0.3.1**.
  That SDK version has NO `systemInstruction` (system prompt is prepended to the first user
  message) and NO `usageMetadata` (tokens counted via `model.countTokens`, falling back to a
  chars/4 estimate). Pricing (approximate; verify): gemini-2.0-flash 10/40,
  gemini-1.5-pro 125/500; fallback = gemini-2.0-flash.
- `src/index.ts` — `complete()` now dispatches all three providers.
- `src/providers/anthropic.ts` — sampling guard: `temperature` is NOT sent to models matching
  `claude-opus-4-(7|8)|claude-fable-5` (those reject sampling params with HTTP 400).

## Call sites parameterized (provider + model threaded through)
- `packages/integrations/src/classifier.ts` — `classifyWithLLM` / `classifyItems` take
  `(…, apiKey, provider: ModelProvider, model: string)`.
- `packages/integrations/src/digest-generator.ts` — `generateDigest` likewise.
- `packages/integrations/src/index.ts` — re-export signatures updated.
- `packages/reporting/src/nl-queries.ts` — `queryProject`, `generateSprintSummary`,
  `generateExecutiveSummary`, `generateChangelog` all take provider/model (the old
  haiku-vs-sonnet split is gone — the user-selected default reasoning model is used).
- `packages/reporting/src/pm-command-center.ts` — `getDashboard(projectId, apiKey, provider, model)`.

## Desktop routes
- `routes/reporting.ts` — `getProjectAndApiKey` now resolves
  `DEFAULT_REASONING_PROVIDER` (fallback `anthropic`) + `DEFAULT_REASONING_MODEL`
  (fallback `claude-haiku-4-5-20251001`) from global settings, then the matching
  `${PROVIDER}_API_KEY`; returns `{ apiKey, provider, model }`; all call sites
  (dashboard, digest, NL query) pass them through. 422 errors name the actual missing key.
- `routes/global-settings.ts` — new `GET /settings/reasoning-defaults` returning
  `{ provider, model }` (these two values are not secrets; API keys stay write-only).
  Defaults are plain rows in the existing encrypted `global_settings` store — no schema change.

## UI (ConnectionsPage only — Settings.tsx untouched per scope)
- "Claude (AI)" section → "AI Models": per-provider key cards (Anthropic / OpenAI / Gemini →
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` via existing PUT/DELETE
  `/settings/:key` + `GET /settings/keys`), plus a "Default reasoning model" picker
  (persists both `DEFAULT_REASONING_PROVIDER` + `DEFAULT_REASONING_MODEL`; options whose
  provider key is missing are disabled). Model list mirrors AgentsPage MODEL_PRESETS:
  claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5-20251001 / gpt-4o / gemini-2.0-flash.
- `QuickAddForm` gained an `ariaLabel` prop (was hardcoded "Anthropic API key").

## Out of scope / untouched
- `packages/integrations/src/connectors/*`, `scripts/*`, `Settings.tsx`, agent-workspaces schema.
- Agent-workspace execution still doesn't call LLMs (unchanged decision).

## Verification (Kali)
- `pnpm run typecheck` — 21/21 green.
- `pnpm test` — 45/45 green (11 suites).
- Deps already installed: `openai@4.104.0`, `@google/generative-ai@0.3.1`.
- Pricing numbers are best-known public list prices, marked `// approximate public pricing; verify`.
