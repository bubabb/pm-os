import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { join } from 'path'

let app: ElectronApplication

test.afterEach(async () => {
  await app?.close()
})

// Exercises the membership/claude-cli provider end to end through the REAL stack:
// renderer → Fastify (GET /settings/claude-cli-health) → checkClaudeCli() → the
// machine's credential store. Proves the AI Models settings reflect the live
// membership status and that the claude-cli (membership) reasoning models are offered.
test('Connections shows live Claude membership status + membership reasoning models', async () => {
  app = await electron.launch({
    args: [
      join(process.cwd(), 'out', 'main', 'index.js'),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  })
  const win = await app.firstWindow()

  // Navigate to Connections (auto-login lands us in the shell; link proves we're past auth).
  await win.getByRole('link', { name: 'Connections' }).click()
  await expect(win.getByRole('heading', { name: 'AI Models' })).toBeVisible({ timeout: 20000 })

  // The membership status card is present and resolves to a live verdict (not stuck "Checking…").
  await expect(win.getByText('Claude membership', { exact: true })).toBeVisible({ timeout: 20000 })
  // On this signed-in machine the health probe should report a signed-in membership.
  await expect(win.getByText(/Signed in/i)).toBeVisible({ timeout: 20000 })

  // The reasoning-model picker offers the membership-backed (claude-cli) models.
  await expect(
    win.locator('#default-reasoning-model option', { hasText: '(membership)' }).first(),
  ).toHaveCount(1)
})
