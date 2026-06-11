import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { runMigrations } from '@creare/database'
import { startServer, stopServer } from './server'
import { startSyncScheduler, stopSyncScheduler } from './scheduler/sync-scheduler'
import { startPushWorker, stopPushWorker } from './sync/push-worker'

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

app.whenReady().then(async () => {
  runMigrations() // bring a fresh ~/.creare/creare.db up to date before serving
  await startServer()
  startSyncScheduler()
  startPushWorker()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  stopPushWorker()
  await stopSyncScheduler()
  await stopServer()
  if (process.platform !== 'darwin') app.quit()
})
