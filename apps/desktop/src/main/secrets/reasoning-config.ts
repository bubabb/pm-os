import { getGlobalSetting } from './global-settings-service'
import { providerNeedsKey } from '@creare/ai-sdk'
import type { ModelProvider } from '@creare/ai-sdk'

// Resolves the workspace-level reasoning model + auth used by the reporting and
// eval routes. The default is the membership-backed `claude-cli` provider, which
// authenticates via the local Claude Code login and needs NO API key — so a fresh
// workspace works out of the box without any key configured. An admin can still
// override DEFAULT_REASONING_PROVIDER to a keyed provider (anthropic/openai/gemini).

export { providerNeedsKey } from '@creare/ai-sdk'

export const VALID_PROVIDERS: ModelProvider[] = ['claude-cli', 'anthropic', 'openai', 'gemini']
export const DEFAULT_REASONING_PROVIDER: ModelProvider = 'claude-cli'
export const DEFAULT_REASONING_MODEL = 'claude-haiku-4-5-20251001'

export interface ReasoningConfig {
  // Empty string when no key is needed (claude-cli) or none is configured. Gate LLM
  // use with llmAvailable(provider, apiKey), not the key's truthiness.
  apiKey: string
  provider: ModelProvider
  model: string
}

export async function resolveReasoningConfig(): Promise<ReasoningConfig> {
  const rawProvider = await getGlobalSetting('DEFAULT_REASONING_PROVIDER')
  const provider = VALID_PROVIDERS.includes(rawProvider as ModelProvider)
    ? (rawProvider as ModelProvider)
    : DEFAULT_REASONING_PROVIDER
  const model = (await getGlobalSetting('DEFAULT_REASONING_MODEL')) ?? DEFAULT_REASONING_MODEL
  // claude-cli needs no key; resolve to '' so downstream `apiKey: string` params are
  // satisfied (complete() ignores the key for claude-cli) and key guards can skip it.
  const apiKey =
    (providerNeedsKey(provider) ? await getGlobalSetting(`${provider.toUpperCase()}_API_KEY`) : '') ?? ''
  return { apiKey, provider, model }
}
