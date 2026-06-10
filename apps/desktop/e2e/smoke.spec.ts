import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'

let app: ElectronApplication

test.afterEach(async () => {
  await app?.close()
})

// Smoke: the built app launches, the main process boots (Fastify + migrations),
// and the renderer paints the login screen. Proves the full Electron stack end to end.
test('boots to the login screen', async () => {
  app = await electron.launch({
    args: [
      join(process.cwd(), 'out', 'main', 'index.js'),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  })
  const win = await app.firstWindow()
  await expect(win.getByText('The agentic DevOps platform')).toBeVisible()
  await expect(win.getByRole('button', { name: /Continue with GitHub/i })).toBeVisible()
  await expect(win.getByRole('button', { name: /Continue with Microsoft/i })).toBeVisible()
})
