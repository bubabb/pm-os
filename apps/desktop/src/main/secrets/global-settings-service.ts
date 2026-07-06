import { getDb, globalSettings } from '@pm-os/database'
import { generateId } from '@pm-os/shared'
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
  try {
    return await decryptSecretAsync(setting.encryptedValue, setting.iv)
  } catch (err) {
    // A value encrypted under a previous master key (e.g. after an OS-keyring
    // hiccup rotated the key) can no longer be decrypted. Treat it as "not set"
    // and degrade to defaults instead of throwing — a single orphaned setting
    // must never 500 the whole dashboard. Re-saving the setting re-encrypts it
    // under the current key.
    console.warn(`[pm-os] global setting "${key}" could not be decrypted (stale key?) — treating as unset:`, err instanceof Error ? err.message : err)
    return null
  }
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
