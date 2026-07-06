import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAuth } from '../auth'
import {
  listGlobalSettingKeys, setGlobalSetting, deleteGlobalSetting, getGlobalSetting,
  DEFAULT_REASONING_PROVIDER, DEFAULT_REASONING_MODEL,
} from '../secrets'
import { checkClaudeCli } from '@pm-os/ai-sdk'

// Workspace-level (GLOBAL) encrypted settings — requireAuth, but NOT project-scoped.
// Values are never returned — only the keys present.

interface SettingParams { key: string }
interface SetSettingBody { value: string }

export async function globalSettingsRoutes(app: FastifyInstance): Promise<void> {
  // List the setting keys present (values are never exposed)
  app.get(
    '/settings/keys',
    { preHandler: requireAuth },
    async () => {
      return listGlobalSettingKeys()
    },
  )

  // Default reasoning model — provider/model ids are NOT secrets, so exposing
  // these two values (and only these) is safe. API keys stay write-only.
  app.get(
    '/settings/reasoning-defaults',
    { preHandler: requireAuth },
    async () => {
      const provider = (await getGlobalSetting('DEFAULT_REASONING_PROVIDER')) ?? DEFAULT_REASONING_PROVIDER
      const model = (await getGlobalSetting('DEFAULT_REASONING_MODEL')) ?? DEFAULT_REASONING_MODEL
      return { provider, model }
    },
  )

  // Claude membership (claude-cli provider) health — confirms the CLI is installed
  // and signed in, so the UI can surface a clear error before reasoning calls fail.
  app.get(
    '/settings/claude-cli-health',
    { preHandler: requireAuth },
    async () => checkClaudeCli(),
  )

  // Set (upsert) a setting value
  app.put<{ Params: SettingParams; Body: SetSettingBody }>(
    '/settings/:key',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SettingParams; Body: SetSettingBody }>, reply) => {
      if (typeof request.body?.value !== 'string' || request.body.value.length === 0) {
        return reply.code(400).send({ error: 'Missing value' })
      }
      await setGlobalSetting(request.params.key, request.body.value)
      return { ok: true }
    },
  )

  // Delete a setting
  app.delete<{ Params: SettingParams }>(
    '/settings/:key',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: SettingParams }>) => {
      await deleteGlobalSetting(request.params.key)
      return { ok: true }
    },
  )
}
