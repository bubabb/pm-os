import { getDb, globalSettings } from '@creare/database'
import { generateId } from '@creare/shared'
import { eq } from 'drizzle-orm'
import { encryptSecretAsync, decryptSecretAsync } from './secrets-service'

// Workspace-level (GLOBAL) encrypted settings — e.g. the Claude API key.
// Values are encrypted with the same AES-256-GCM helpers as `secrets`.

export async function setGlobalSetting(key: string, value: string): Promise<void> {
  const { encryptedValue, iv } = await encryptSecretAsync(value)
  const db = getDb()
  await db
    .insert(globalSettings)
    .values({ id: generateId(), key, encryptedValue, iv })
    .onConflictDoUpdate({
      target: globalSettings.key,
      set: { encryptedValue, iv, updatedAt: new Date().toISOString() },
    })
}

// Returns the plaintext value, or null if the key is not set.
// Never log or expose the return value.
export async function getGlobalSetting(key: string): Promise<string | null> {
  const db = getDb()
  const [setting] = await db
    .select()
    .from(globalSettings)
    .where(eq(globalSettings.key, key))
    .limit(1)
  if (!setting) return null
  return decryptSecretAsync(setting.encryptedValue, setting.iv)
}

export async function listGlobalSettingKeys(): Promise<string[]> {
  const db = getDb()
  const rows = await db.select({ key: globalSettings.key }).from(globalSettings)
  return rows.map((row) => row.key)
}

export async function deleteGlobalSetting(key: string): Promise<void> {
  const db = getDb()
  await db.delete(globalSettings).where(eq(globalSettings.key, key))
}
