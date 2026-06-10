import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'

let app: ElectronApplication

test.afterEach(async () => {
  await app?.close()
})

// Smoke: the built app launches, the main process boots (Fastify + migrations),
// and the renderer auto-signs-in a local user and paints the app shell — there is
// no login gate. Proves the full Electron stack end to end.
test('boots straight into the app shell (no login gate)', async () => {
  app = await electron.launch({
    args: [
      join(process.cwd(), 'out', 'main', 'index.js'),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  })
  const win = await app.firstWindow()
  // Auto-login lands on the app shell; a sidebar nav item proves we're past auth.
  await expect(win.getByRole('link', { name: 'Connections' })).toBeVisible({ timeout: 20000 })
  // The old login screen must NOT appear.
  await expect(win.getByRole('button', { name: /Continue with GitHub/i })).toHaveCount(0)
})
