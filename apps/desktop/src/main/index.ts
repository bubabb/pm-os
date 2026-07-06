import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { runMigrations } from '@creare/database'
import { startServer, stopServer } from './server'
import { startSyncScheduler, stopSyncScheduler } from './scheduler/sync-scheduler'
import { startPushWorker, stopPushWorker } from './sync/push-worker'

// The Electron desktop app is a trusted local context and (Phase 1) ships without
// real OAuth, so enable the dev-stub sign-in by default here. A bare headless server
// stays gated: it only allows dev sign-in when the operator sets CREARE_DEV_AUTH=1
// explicitly (the `pnpm server`/`pnpm creare` scripts do). Set before startServer so
// the auth routes see it.
process.env['CREARE_DEV_AUTH'] ??= '1'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  })

  win.once('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Stop backend services exactly once, on real quit (before-quit), regardless of
// platform or how the quit was triggered.
let servicesStopped = false
async function stopServices(): Promise<void> {
  if (servicesStopped) return
  servicesStopped = true
  stopPushWorker()
  await stopSyncScheduler()
  await stopServer()
}

// Single-instance lock — a second launch would race the same SQLite DB and port.
// The losing instance quits immediately; the winner focuses its existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      runMigrations() // bring a fresh ~/.creare/creare.db up to date before serving
      await startServer()
      startSyncScheduler()
      startPushWorker()
      createWindow()
      app.on('activate', () => {
        // Services keep running on macOS while all windows are closed — just
        // recreate the window; the backend is already live.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Creare failed to start', message)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    // macOS: keep the backend (server/scheduler/push-worker) alive so `activate`
    // can reopen a window against a live backend. Elsewhere: quit (services are
    // torn down in before-quit).
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (servicesStopped) return
    // Hold the quit until async teardown finishes, then re-quit; the
    // servicesStopped flag lets the second quit pass through.
    event.preventDefault()
    void stopServices().finally(() => app.quit())
  })
}
