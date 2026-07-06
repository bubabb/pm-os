/**
 * Optional Electron access for backend code that ALSO runs in the headless
 * "Pm.Os Server" runtime.
 *
 * The headless server is plain Node with NO Electron binary installed
 * (`pnpm install --ignore-scripts`), so a top-level `import { x } from 'electron'`
 * throws at module load — `require('electron')` errors with "Electron failed to
 * install correctly". These helpers load Electron lazily and return null when it
 * isn't available, letting the backend degrade gracefully:
 *   - safeStorage  → only a one-time legacy key migration uses it (skipped headless;
 *     fresh installs store raw keys in keys.json and never need it).
 *   - BrowserWindow → only the desktop OAuth sign-in flow uses it (callers throw a
 *     clear error at call time; PAT-based connectors + the dev-stub need nothing).
 *
 * The `import type` below is fully erased at runtime, so it does not re-introduce
 * the eager load this module exists to avoid — only the lazy require() loads code.
 */
import type { SafeStorage, BrowserWindow } from 'electron'

function loadElectron(): Record<string, unknown> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron') as Record<string, unknown>
  } catch {
    return null
  }
}

/** Electron's safeStorage, or null when running headless (no Electron). */
export function getSafeStorage(): SafeStorage | null {
  return (loadElectron()?.['safeStorage'] as SafeStorage | undefined) ?? null
}

/** Electron's BrowserWindow constructor, or null when running headless. */
export function getBrowserWindowCtor(): typeof BrowserWindow | null {
  return (loadElectron()?.['BrowserWindow'] as typeof BrowserWindow | undefined) ?? null
}
